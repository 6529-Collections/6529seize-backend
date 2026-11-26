import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { identityRatingsFeed } from '@/notifications/view/feeds/identity-ratings-feed';
import {
  notificationFeedRunner,
  NotificationFeed,
  NotificationFeedRunner
} from '@/notifications/view/notification-feed-runner';
import {
  derivedCauses,
  notifyViewMode
} from '@/notifications/view/notify-view-flags';

/** A feed that runs in production, and the causes its rule writes. */
export interface ProductionFeed {
  readonly feed: NotificationFeed<any>;
  readonly causes: readonly IdentityNotificationCause[];
}

/** The feeds that run in production; CAUSES_WITH_FEEDS lists their causes. */
export const PRODUCTION_FEEDS: readonly ProductionFeed[] = [
  {
    feed: identityRatingsFeed,
    causes: [
      IdentityNotificationCause.IDENTITY_REP,
      IdentityNotificationCause.IDENTITY_NIC
    ]
  }
];

/** How long one run may keep starting batches. */
const RUN_BUDGET_MS = 60_000;
/**
 * Kept back from a Lambda's remaining time when the feeds run at its end:
 * the last batch, which may start just before the budget ends, and the
 * database context's close.
 */
const FEEDS_END_RESERVE_MS = 30_000;
/** With less than this for the feeds, they wait for the next run. */
const FEEDS_MIN_RUN_MS = 15_000;

const logger = Logger.get('NOTIFICATION_FEEDS');

/**
 * Runs each production feed once, live, from its cursor: the feeds whose
 * causes NOTIFY_DERIVED_CAUSES names, while the mode is not `off`. They
 * start batches until `deadlineMs` (an absolute time), and for at most a
 * minute. A feed's failure is logged, never thrown; the next run starts
 * from the cursor.
 */
export async function runNotificationFeeds(
  feeds: readonly ProductionFeed[] = PRODUCTION_FEEDS,
  runner: NotificationFeedRunner = notificationFeedRunner,
  deadlineMs: number = Number.POSITIVE_INFINITY
): Promise<void> {
  if (notifyViewMode() === 'off') return;
  const derived = derivedCauses();
  const untilMs = Math.min(deadlineMs, Date.now() + RUN_BUDGET_MS);
  for (const { feed, causes } of feeds) {
    if (!causes.some((cause) => derived.has(cause))) continue;
    try {
      const result = await runner.run(feed, { mode: 'live', untilMs });
      logger.info(
        `[NOTIFY_FEED] [FEED ${feed.name}] ${result.events} events in ${result.batches} batches, ${result.derived.written} rows written, ${result.derived.pushed} pushes`
      );
    } catch (error) {
      logger.error(`[NOTIFY_FEED_FAILED] [FEED ${feed.name}] ${error}`);
      sentryContext.captureException(error);
    }
  }
}

/**
 * The production feeds, in a database context of their own, for a loop to
 * call at the end of every run, a failed one too: delegationsLoop does, so
 * ratings are read right after the identity mirror writes them. Nothing
 * runs while the view is `off`. A failure is logged and reported, never
 * thrown, so the loop's own result stands.
 */
export async function runNotificationFeedsSafely(
  runFeeds: () => Promise<void> = () => runNotificationFeeds()
): Promise<void> {
  if (notifyViewMode() === 'off') return;
  try {
    await doInDbContext(runFeeds, { logger });
  } catch (error) {
    logger.error(`[NOTIFY_FEEDS_FAILED] ${error}`);
    sentryContext.captureException(error);
  }
}

/**
 * runNotificationFeedsSafely at the end of a Lambda run, within what the
 * Lambda has left (`timeLeft`, its remaining milliseconds): the feeds get at
 * most a minute and end `FEEDS_END_RESERVE_MS` before the Lambda's limit, so
 * a long run is never timed out by them. The deadline is fixed before the
 * database context opens, so opening it counts against the budget. With
 * under `FEEDS_MIN_RUN_MS` for them, they wait for the next run, whose
 * start reads from the cursor.
 */
export async function runNotificationFeedsWithin(
  timeLeft: () => number,
  runFeeds: (deadlineMs: number) => Promise<void> = (deadlineMs) =>
    runNotificationFeeds(PRODUCTION_FEEDS, notificationFeedRunner, deadlineMs)
): Promise<void> {
  if (notifyViewMode() === 'off') return;
  const budgetMs = Math.min(RUN_BUDGET_MS, timeLeft() - FEEDS_END_RESERVE_MS);
  if (budgetMs < FEEDS_MIN_RUN_MS) {
    logger.warn('[NOTIFY_FEEDS_WAIT_FOR_THE_NEXT_RUN] [NO TIME LEFT]');
    return;
  }
  const deadlineMs = Date.now() + budgetMs;
  await runNotificationFeedsSafely(() => runFeeds(deadlineMs));
}
