jest.mock('@/notifications/view/feeds/identity-ratings-feed', () => ({
  identityRatingsFeed: { name: 'identity:ratings' }
}));
jest.mock('@/notifications/view/notification-feed-runner', () => ({
  notificationFeedRunner: { run: jest.fn() }
}));
jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (work: () => Promise<unknown>) => work())
}));
jest.mock('@/sentry.context', () => ({ captureException: jest.fn() }));

import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { Logger } from '@/logging';
import type {
  NotificationFeedRunner,
  NotificationFeed
} from './notification-feed-runner';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import {
  PRODUCTION_FEEDS,
  runNotificationFeeds,
  runNotificationFeedsSafely
} from './notification-feeds';
import { CAUSES_WITH_FEEDS } from './notify-view-flags';

const KEYS = ['NOTIFY_VIEW_MODE', 'NOTIFY_DERIVED_CAUSES'] as const;
const feed = (name: string) => ({ name }) as NotificationFeed<unknown>;
const RATINGS = {
  feed: feed('ratings'),
  causes: [IdentityNotificationCause.IDENTITY_REP]
};
const VOTES = {
  feed: feed('votes'),
  causes: [IdentityNotificationCause.DROP_VOTED]
};

describe('runNotificationFeeds', () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const run = jest.fn();
  const runner = { run } as unknown as NotificationFeedRunner;
  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
    run.mockReset();
    run.mockResolvedValue({
      feed: 'x',
      events: 0,
      batches: 0,
      derived: { written: 0, removed: 0, legacyCopies: 0, pushed: 0 }
    });
  });
  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('lists in CAUSES_WITH_FEEDS exactly the causes its production feeds write', () => {
    expect(new Set(PRODUCTION_FEEDS.flatMap(({ causes }) => causes))).toEqual(
      new Set(CAUSES_WITH_FEEDS)
    );
  });

  it('runs nothing while the view is off', async () => {
    process.env.NOTIFY_DERIVED_CAUSES = 'IDENTITY_REP@0';
    await runNotificationFeeds([RATINGS], runner);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs, live and within a time budget, only the feeds whose causes are derived', async () => {
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    process.env.NOTIFY_DERIVED_CAUSES = `IDENTITY_REP@${Date.now() + 60_000}`;
    await runNotificationFeeds([RATINGS, VOTES], runner);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(RATINGS.feed, {
      mode: 'live',
      untilMs: expect.any(Number)
    });
  });

  it('keeps starting batches until its deadline, and for never more than a minute', async () => {
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    process.env.NOTIFY_DERIVED_CAUSES = `IDENTITY_REP@${Date.now() + 60_000}`;
    const untilOf = async (deadlineMs?: number) => {
      run.mockClear();
      await runNotificationFeeds([RATINGS], runner, deadlineMs);
      return run.mock.calls[0][1].untilMs;
    };
    const deadline = Date.now() + 20_000;
    expect(await untilOf(deadline)).toBe(deadline);
    const before = Date.now();
    expect(await untilOf(before + 600_000)).toBeLessThan(before + 61_000);
    expect(await untilOf()).toBeGreaterThanOrEqual(before + 60_000);
  });

  describe('runNotificationFeedsSafely', () => {
    it('opens no database context and runs nothing while the view is off', async () => {
      jest.mocked(doInDbContext).mockClear();
      const runFeeds = jest.fn(async () => undefined);
      await runNotificationFeedsSafely(runFeeds);
      expect(doInDbContext).not.toHaveBeenCalled();
      expect(runFeeds).not.toHaveBeenCalled();
    });

    it('runs the feeds in a database context of their own', async () => {
      process.env.NOTIFY_VIEW_MODE = 'shadow';
      jest.mocked(doInDbContext).mockClear();
      const runFeeds = jest.fn(async () => undefined);
      await runNotificationFeedsSafely(runFeeds);
      expect(doInDbContext).toHaveBeenCalledTimes(1);
      expect(runFeeds).toHaveBeenCalledTimes(1);
    });

    it("logs and reports a failure of the feeds, and doesn't throw it", async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        process.env.NOTIFY_VIEW_MODE = 'on';
        await expect(
          runNotificationFeedsSafely(async () => {
            throw new Error('feeds down');
          })
        ).resolves.toBeUndefined();
        expect(sentryContext.captureException).toHaveBeenCalled();
        expect(
          error.mock.calls.some(([message]) =>
            String(message).includes('[NOTIFY_FEEDS_FAILED]')
          )
        ).toBe(true);
      } finally {
        error.mockRestore();
      }
    });
  });

  it("logs a feed's failure and goes on to the next feed", async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      process.env.NOTIFY_VIEW_MODE = 'on';
      process.env.NOTIFY_DERIVED_CAUSES = `IDENTITY_REP@${Date.now() + 60_000},DROP_VOTED@${Date.now() + 60_000}`;
      run.mockRejectedValueOnce(new Error('no such table'));
      await expect(
        runNotificationFeeds([RATINGS, VOTES], runner)
      ).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledTimes(2);
      expect(
        error.mock.calls.some(([message]) =>
          String(message).includes('[NOTIFY_FEED_FAILED] [FEED ratings]')
        )
      ).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});
