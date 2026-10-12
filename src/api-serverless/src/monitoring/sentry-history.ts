import { createHash } from 'node:crypto';
import { redisCachedWithRefreshLease } from '@/redis';
import { Time } from '@/time';
import {
  ApiMonitoringSentryHistory,
  ApiMonitoringSentryHistoryStatusEnum,
  ApiMonitoringSentryHistoryPeriodEnum,
  ApiMonitoringSentryHistoryTimezoneEnum
} from '@/api/generated/models/ApiMonitoringSentryHistory';
import { ApiMonitoringSentryHistoryDay } from '@/api/generated/models/ApiMonitoringSentryHistoryDay';
import {
  countSentryWindow,
  getSentryConfig,
  SentryConfig,
  SentryRateLimitError
} from './sentry-overview';

const DAY_MS = 86_400_000;
const DAYS = 30;
const CONCURRENCY = 4;
const COLLECTION_TIMEOUT_MS = 18_000;
const inFlight = new Map<string, Promise<ApiMonitoringSentryHistory>>();

async function collectHistory(
  config: SentryConfig,
  end: Date
): Promise<ApiMonitoringSentryHistory> {
  const start = new Date(end.getTime() - DAYS * DAY_MS);
  const projects = config.projects.map((project) => ({
    project,
    days: Array.from(
      { length: DAYS },
      (_, index): ApiMonitoringSentryHistoryDay => ({
        date: new Date(start.getTime() + index * DAY_MS)
          .toISOString()
          .slice(0, 10),
        events: null,
        issues: null
      })
    )
  }));
  // Recent days first so a provider timeout still leaves the most useful data.
  const jobs = projects
    .flatMap((project) =>
      [...project.days].reverse().map((day) => ({
        project: project.project,
        day
      }))
    )
    .sort((a, b) => b.day.date.localeCompare(a.day.date));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COLLECTION_TIMEOUT_MS);
  let nextJob = 0;
  const worker = async () => {
    while (!controller.signal.aborted && nextJob < jobs.length) {
      const { project, day } = jobs[nextJob++];
      const dayStart = `${day.date}T00:00:00.000Z`;
      const dayEnd = new Date(Date.parse(dayStart) + DAY_MS).toISOString();
      try {
        const counts = await countSentryWindow(
          config,
          project,
          dayStart,
          dayEnd,
          controller.signal
        );
        if (counts) {
          day.events = counts.events;
          day.issues = counts.issues;
        }
      } catch (error) {
        // A failed/incomplete day stays missing, never a false zero. Stop on rate limits.
        if (error instanceof SentryRateLimitError) controller.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    clearTimeout(timeout);
  }
  if (
    !projects.some((project) => project.days.some((day) => day.events !== null))
  ) {
    throw new Error('Sentry history collection unavailable');
  }
  return {
    status: ApiMonitoringSentryHistoryStatusEnum.Ready,
    environment: config.environment,
    period: ApiMonitoringSentryHistoryPeriodEnum._30d,
    timezone: ApiMonitoringSentryHistoryTimezoneEnum.Utc,
    fetched_at: new Date(),
    window_start: start,
    window_end: end,
    projects
  };
}

export async function getSentryHistory(): Promise<ApiMonitoringSentryHistory> {
  const config = getSentryConfig();
  if (!config)
    return {
      status: ApiMonitoringSentryHistoryStatusEnum.NotConfigured,
      environment: '',
      period: ApiMonitoringSentryHistoryPeriodEnum._30d,
      timezone: ApiMonitoringSentryHistoryTimezoneEnum.Utc,
      projects: []
    };
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const hash = createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex');
  const key = `monitoring:sentry:history:v1:${hash}:${end.toISOString().slice(0, 10)}`;
  const pending = inFlight.get(key);
  if (pending !== undefined) return await pending;
  const task = (async () => {
    // Reuse the shared Redis refresh lease to avoid duplicate collection across Lambdas.
    const snapshot = await redisCachedWithRefreshLease(
      key,
      Time.minutes(15),
      () => collectHistory(config, end)
    );
    if (!snapshot) throw new Error('Sentry history refresh pending');
    return snapshot;
  })();
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}
