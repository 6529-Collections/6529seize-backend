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
/** When this instance loaded its configuration. */
const INSTANCE_STARTED_AT = Date.now();

/**
 * The causes a production feed derives (PRODUCTION_FEEDS in
 * notification-feeds.ts). A cause joins with its feed; a derived cause
 * outside this set has its old writer skipped and nothing writing it,
 * which is reported.
 */
export const CAUSES_WITH_FEEDS: ReadonlySet<IdentityNotificationCause> =
  new Set<IdentityNotificationCause>([
    IdentityNotificationCause.IDENTITY_REP,
    IdentityNotificationCause.IDENTITY_NIC
  ]);

/**
 * A span in which the deriver owns a cause: from `start` (inclusive) to
 * `end` (exclusive), both milliseconds since the epoch; `end` is null while
 * the window is open.
 */
export interface CauseWindow {
  readonly start: number;
  readonly end: number | null;
}

const windowText = (cause: string, window: CauseWindow) =>
  `${cause}@${window.start}${window.end === null ? '' : `..${window.end}`}`;

function parseWindow(
  item: string
): { cause: IdentityNotificationCause; window: CauseWindow } | null {
  const [rawCause, rawWindow, extra] = item.split('@');
  const cause = rawCause.trim().toUpperCase();
  if (extra !== undefined || !CAUSES.has(cause) || !rawWindow) return null;
  const [rawStart, rawEnd, more] = rawWindow.trim().split('..');
  const start = Number(rawStart.trim() || NaN);
  const end = rawEnd === undefined ? null : Number(rawEnd.trim() || NaN);
  if (
    more !== undefined ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (end !== null && (!Number.isSafeInteger(end) || end <= start))
  ) {
    return null;
  }
  return { cause: cause as IdentityNotificationCause, window: { start, end } };
}

/**
 * NOTIFY_DERIVED_CAUSES: comma-separated windows, `CAUSE@startMs` (open) or
 * `CAUSE@startMs..endMs` (closed). Within a window a cause comes from the
 * deriver and its old writers are skipped; outside every window its old
 * writers' rows stand. Old writers compare the windows with the time they
 * write, the deriver with the event's time, so each event is written by
 * exactly one.
 *
 * A cause's windows only grow: to hand a cause back to its old writer,
 * close its window with an end later than the deploy that sets it; to
 * derive it again, add a window after that. A cause never leaves the list
 * once logged (`record-cuts`), since a rebuild derives it in those windows.
 * The start is required: a cause whose old writer has written rows would
 * otherwise be written twice for the same events.
 *
 * Ignored while the mode is `off`, so `off` restores every old writer. An
 * item with an unknown name or a malformed window, or one that overlaps an
 * earlier window of its cause, is ignored and reported once per value.
 */
export function derivedCauseWindows(): ReadonlyMap<
  IdentityNotificationCause,
  readonly CauseWindow[]
> {
  const windows = new Map<IdentityNotificationCause, CauseWindow[]>();
  if (notifyViewMode() === 'off') return windows;
  const value = process.env.NOTIFY_DERIVED_CAUSES ?? '';
  const rejected: string[] = [];
  const parsed: { cause: IdentityNotificationCause; window: CauseWindow }[] =
    [];
  for (const item of value.split(',')) {
    if (!item.trim()) continue;
    const window = parseWindow(item.trim());
    if (window) parsed.push(window);
    else rejected.push(item.trim());
  }
  parsed.sort((a, b) => a.window.start - b.window.start);
  for (const { cause, window } of parsed) {
    const list = windows.get(cause) ?? [];
    const last = list.at(-1);
    if (last && (last.end === null || last.end > window.start)) {
      rejected.push(windowText(cause, window));
      continue;
    }
    list.push(window);
    windows.set(cause, list);
  }
  if (reportedValue !== value) {
    reportedValue = value;
    reportWindows(windows, rejected);
  }
  return windows;
}

function reportWindows(
  windows: ReadonlyMap<IdentityNotificationCause, readonly CauseWindow[]>,
  rejected: readonly string[]
) {
  if (rejected.length) {
    logger.error(
      `[NOTIFY_DERIVED_CAUSES_IGNORED] ${rejected.join(', ')}: each item must be CAUSE@startMs or CAUSE@startMs..endMs, after the cause's earlier windows; the old writers keep writing outside the windows kept`
    );
  }
  const now = Date.now();
  const feedless = Array.from(windows.entries())
    .filter(
      ([cause, list]) =>
        !CAUSES_WITH_FEEDS.has(cause) &&
        list.some((window) => window.end === null || window.end > now)
    )
    .map(([cause]) => cause);
  if (feedless.length) {
    logger.error(
      `[NOTIFY_DERIVED_CAUSE_WITHOUT_FEED] ${feedless.join(', ')}: their old writers are skipped and no feed derives them`
    );
  }
  // A window's start and end must be later than the deploy that sets them.
  // An instance that starts later can't tell a late start from a time set
  // in the past, so it says so once about each cause's latest change.
  const early = Array.from(windows.entries())
    .map(([cause, list]) => [cause, list.at(-1)!] as const)
    .filter(([, last]) => (last.end ?? last.start) < INSTANCE_STARTED_AT);
  if (early.length) {
    logger.warn(
      `[NOTIFY_DERIVED_CAUSE_CUT_BEFORE_START] ${early
        .map(([cause, last]) => windowText(cause, last))
        .join(
          ', '
        )}: earlier than this instance's start. If the deploy that set it started later, the events in between were written by the side that no longer owns them`
    );
  }
}

/** The windows as `record-cuts` logs them: [start, end or null] per cause. */
export function loggedWindows(
  windows: ReadonlyMap<string, readonly CauseWindow[]>
): Record<string, [number, number | null][]> {
  return Object.fromEntries(
    Array.from(windows.entries()).map(([cause, list]) => [
      cause,
      list.map((window): [number, number | null] => [window.start, window.end])
    ])
  );
}

export function derivedCauses(): ReadonlySet<IdentityNotificationCause> {
  return new Set(derivedCauseWindows().keys());
}

/** Whether the deriver owns this cause at this time (now, by default). */
export function isDerivedCause(
  cause: IdentityNotificationCause,
  atMs: number = Date.now()
): boolean {
  return (derivedCauseWindows().get(cause) ?? []).some(
    (window) =>
      atMs >= window.start && (window.end === null || atMs < window.end)
  );
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
