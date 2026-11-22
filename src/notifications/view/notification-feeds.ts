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

const logger = Logger.get('NOTIFICATION_FEEDS');

/**
 * Runs each production feed once, live, from its cursor: the feeds whose
 * causes NOTIFY_DERIVED_CAUSES names, while the mode is not `off`. A
 * feed's failure is logged, never thrown; the next run starts from the
 * cursor.
 */
export async function runNotificationFeeds(
  feeds: readonly ProductionFeed[] = PRODUCTION_FEEDS,
  runner: NotificationFeedRunner = notificationFeedRunner
): Promise<void> {
  if (notifyViewMode() === 'off') return;
  const derived = derivedCauses();
  const untilMs = Date.now() + RUN_BUDGET_MS;
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
