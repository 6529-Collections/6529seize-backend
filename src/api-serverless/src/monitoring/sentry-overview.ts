import { createHash } from 'node:crypto';
import fetch from 'node-fetch';
import { env } from '@/env';
import { redisCached } from '@/redis';
import { Time } from '@/time';
import {
  ApiMonitoringSentryIssue,
  ApiMonitoringSentryIssueLevelEnum,
  ApiMonitoringSentryIssuePriorityEnum,
  ApiMonitoringSentryIssueStateEnum
} from '@/api/generated/models/ApiMonitoringSentryIssue';
import { ApiMonitoringSentryIssueGroup } from '@/api/generated/models/ApiMonitoringSentryIssueGroup';
import { ApiMonitoringSentryEventTrend } from '@/api/generated/models/ApiMonitoringSentryEventTrend';
import { ApiMonitoringSentryProjectOverview } from '@/api/generated/models/ApiMonitoringSentryProjectOverview';
import {
  ApiMonitoringSentryOverview,
  ApiMonitoringSentryOverviewStatusEnum
} from '@/api/generated/models/ApiMonitoringSentryOverview';

const SENTRY_ORIGIN = 'https://sentry.io';
const ISSUE_LIMIT = 5;
const TREND_PAGE_SIZE = 50;
const TREND_MAX_PAGES = 5;
const inFlight = new Map<string, Promise<ApiMonitoringSentryOverview>>();

export interface SentryConfig {
  token: string;
  organization: string;
  projects: string[];
  environment: string;
  environmentFilters: string[];
}

export function getSentryConfig(): SentryConfig | null {
  const token = env.getStringOrNull('MONITORING_SENTRY_TOKEN')?.trim();
  const organization = env.getStringOrNull('MONITORING_SENTRY_ORG')?.trim();
  const projects = env
    .getStringOrNull('MONITORING_SENTRY_PROJECTS')
    ?.split(';')
    .map((project) => project.trim())
    .filter(Boolean);
  const environment =
    env.getStringOrNull('MONITORING_SENTRY_ENVIRONMENT')?.trim() ||
    'production';
  const environmentFilters = (
    env.getStringOrNull('MONITORING_SENTRY_ENVIRONMENT_FILTERS')?.trim() ||
    environment
  )
    .split(';')
    .map((filter) => filter.trim());
  if (!token || !organization || !projects?.length) return null;
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(organization) ||
    projects.length > 10 ||
    projects.some(
      (project) => !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/.test(project)
    ) ||
    environment.length > 100 ||
    /[\r\n]/.test(environment) ||
    environmentFilters.length > 10 ||
    environmentFilters.some(
      (filter) =>
        !/^(?:[a-zA-Z0-9_-]+|\*_[a-zA-Z0-9_-]+)$/.test(filter) ||
        filter.length > 100
    )
  )
    throw new Error('Invalid Sentry monitoring configuration');
  return {
    token,
    organization,
    projects: Array.from(new Set(projects)).sort((a, b) => a.localeCompare(b)),
    environment,
    environmentFilters: Array.from(new Set(environmentFilters)).sort((a, b) =>
      a.localeCompare(b)
    )
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Sentry response');
  }
  return value as Record<string, unknown>;
}

function textField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Invalid Sentry text');
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  })
    .join('')
    .trim()
    .slice(0, maxLength);
}

function dateField(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid Sentry date');
  }
  return new Date(value).toISOString();
}

function parseIssue(
  value: unknown,
  organization: string
): ApiMonitoringSentryIssue {
  const issue = record(value);
  const id = issue.id;
  if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) {
    throw new Error('Invalid Sentry issue ID');
  }
  // Sentry supplies window-scoped aggregates in `filtered` when available.
  // The request also explicitly bounds start/end, so count is never requested as a lifetime total.
  const scoped = issue.filtered ? record(issue.filtered) : issue;
  return {
    id,
    short_id: textField(issue.shortId, 100),
    title: textField(issue.title, 180),
    project: textField(record(issue.project).slug, 100),
    occurrences: countField(scoped.count),
    first_seen: dateField(scoped.firstSeen),
    last_seen: dateField(scoped.lastSeen),
    url: `${SENTRY_ORIGIN}/organizations/${encodeURIComponent(organization)}/issues/${id}/`,
    level: enumField(issue.level, ApiMonitoringSentryIssueLevelEnum),
    priority: enumField(issue.priority, ApiMonitoringSentryIssuePriorityEnum),
    state: issueState(issue)
  };
}

function countField(rawCount: unknown): number {
  if (typeof rawCount !== 'string' || !/^\d{1,16}$/.test(rawCount)) {
    throw new Error('Invalid Sentry count');
  }
  const occurrences = Number(rawCount);
  if (!Number.isSafeInteger(occurrences))
    throw new Error('Invalid Sentry count');
  return occurrences;
}

function enumField<T extends string>(
  value: unknown,
  values: Record<string, T> & { Unknown: T }
): T {
  return (
    Object.values(values).find((candidate) => candidate === value) ??
    values.Unknown
  );
}

function issueState(
  issue: Record<string, unknown>
): ApiMonitoringSentryIssueStateEnum {
  if (issue.status === 'resolved')
    return ApiMonitoringSentryIssueStateEnum.Resolved;
  if (issue.status === 'ignored' || issue.status === 'archived')
    return ApiMonitoringSentryIssueStateEnum.Archived;
  if (issue.status !== 'unresolved')
    return ApiMonitoringSentryIssueStateEnum.Unknown;
  return enumField(issue.substatus, ApiMonitoringSentryIssueStateEnum);
}

async function fetchIssuePage(
  config: SentryConfig,
  project: string,
  start: string,
  end: string,
  query: string,
  sort: string,
  limit: number,
  cursor?: string,
  signal?: AbortSignal
) {
  const url = new URL(
    `/api/0/organizations/${encodeURIComponent(config.organization)}/issues/`,
    SENTRY_ORIGIN
  );
  url.searchParams.set('project', project);
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);
  url.searchParams.set('groupStatsPeriod', '24h');
  url.searchParams.append('collapse', 'lifetime');
  // Explicit tag search supports suffix wildcards; the environment URL filter does not.
  // This includes every service's *_prod events without maintaining a service allowlist.
  url.searchParams.set(
    'query',
    `${query} tags[environment]:[${config.environmentFilters.join(',')}]`
  );
  url.searchParams.set('sort', sort);
  url.searchParams.set('limit', String(limit));
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json'
    },
    timeout: 8_000,
    size: 512_000,
    redirect: 'error',
    signal
  });
  if (response.status === 429) throw new SentryRateLimitError();
  if (!response.ok) throw new Error('Sentry request failed');
  const body: unknown = await response.json();
  if (!Array.isArray(body) || body.length > limit)
    throw new Error('Invalid Sentry issues');
  return { body: body as unknown[], response };
}

async function fetchIssues(
  config: SentryConfig,
  project: string,
  start: string,
  end: string,
  query: string,
  sort: string
): Promise<ApiMonitoringSentryIssueGroup> {
  const { body, response } = await fetchIssuePage(
    config,
    project,
    start,
    end,
    query,
    sort,
    ISSUE_LIMIT + 1
  );
  const hasMore =
    body.length > ISSUE_LIMIT ||
    nextCursor(response.headers.get('link')) !== null;
  const hits = response.headers.get('x-hits');
  const maxHits = response.headers.get('x-max-hits');
  const providerCount = hits && /^\d{1,15}$/.test(hits) ? Number(hits) : null;
  const providerLimit =
    maxHits && /^\d{1,15}$/.test(maxHits) ? Number(maxHits) : null;
  // Sentry caps X-Hits at X-Max-Hits. A capped/missing count stays a lower bound.
  const exactHeader =
    providerCount !== null &&
    providerLimit !== null &&
    providerCount >= body.length &&
    providerCount < providerLimit;
  return {
    issues: body
      .slice(0, ISSUE_LIMIT)
      .map((issue: unknown) => parseIssue(issue, config.organization)),
    count: exactHeader ? providerCount : body.length,
    count_exact: exactHeader || !hasMore,
    has_more: hasMore || (exactHeader && providerCount > body.length)
  };
}

function nextCursor(link: string | null): string | null {
  const next = link?.split(',').find((part) => /rel="next"/.test(part));
  if (!next || !/results="true"/.test(next)) return null;
  const cursor = /cursor="([a-zA-Z0-9_:.=-]{1,200})"/.exec(next)?.[1];
  if (!cursor) throw new Error('Invalid Sentry cursor');
  // Only copy the cursor; never follow a provider-supplied URL with our token.
  return cursor;
}

export class SentryRateLimitError extends Error {
  constructor() {
    super('Sentry rate limit reached');
    this.name = 'SentryRateLimitError';
    // The root TypeScript target is ES5; preserve instanceof after Error subclassing.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function countSentryWindow(
  config: SentryConfig,
  project: string,
  start: string,
  end: string,
  signal?: AbortSignal
): Promise<{ events: number; issues: number } | null> {
  let total = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < TREND_MAX_PAGES; page++) {
    if (signal?.aborted) return null;
    const { body, response } = await fetchIssuePage(
      config,
      project,
      start,
      end,
      'issue.category:error',
      'freq',
      TREND_PAGE_SIZE,
      cursor,
      signal
    );
    for (const value of body) {
      const issue = record(value);
      const id = textField(issue.id, 30);
      if (seen.has(id)) return null; // Pagination moved while collecting; don't claim a total.
      seen.add(id);
      const scoped = issue.filtered ? record(issue.filtered) : issue;
      total += countField(scoped.count);
      if (!Number.isSafeInteger(total)) throw new Error('Invalid Sentry total');
    }
    const link = response.headers.get('link');
    const next = nextCursor(link);
    if (!next) {
      return !link && body.length === TREND_PAGE_SIZE
        ? null
        : { events: total, issues: seen.size };
    }
    if (next === cursor) return null;
    cursor = next;
  }
  return null;
}

async function collectTrend(
  config: SentryConfig,
  project: string,
  start: string,
  end: string
): Promise<ApiMonitoringSentryEventTrend> {
  const previousStart = new Date(Date.parse(start) - 86_400_000).toISOString();
  const [current, previous] = await Promise.all(
    [
      countSentryWindow(config, project, start, end),
      countSentryWindow(config, project, previousStart, start)
    ].map((task) => task.catch(() => null))
  );
  return {
    current_events: current?.events ?? null,
    previous_events: previous?.events ?? null
  };
}

async function collectProject(
  config: SentryConfig,
  project: string,
  start: string,
  end: string
): Promise<ApiMonitoringSentryProjectOverview> {
  const [
    newIssues,
    topIssues,
    highPriority,
    regressed,
    escalating,
    eventTrend
  ] = await Promise.all([
    fetchIssues(
      config,
      project,
      start,
      end,
      `issue.category:error firstSeen:>=${start}`,
      'new'
    ),
    fetchIssues(
      config,
      project,
      start,
      end,
      'is:unresolved issue.category:error',
      'freq'
    ),
    fetchIssues(
      config,
      project,
      start,
      end,
      'is:unresolved issue.category:error issue.priority:high',
      'freq'
    ),
    fetchIssues(
      config,
      project,
      start,
      end,
      'is:regressed issue.category:error',
      'freq'
    ),
    fetchIssues(
      config,
      project,
      start,
      end,
      'is:escalating issue.category:error',
      'freq'
    ),
    collectTrend(config, project, start, end)
  ]);
  return {
    project,
    new_issues: newIssues.issues,
    top_issues: topIssues.issues,
    new_issues_has_more: newIssues.has_more,
    top_issues_has_more: topIssues.has_more,
    new_issues_total: newIssues.count,
    new_issues_count_exact: newIssues.count_exact,
    high_priority: highPriority,
    regressed,
    escalating,
    event_trend: eventTrend
  };
}

async function collectOverview(
  config: SentryConfig
): Promise<ApiMonitoringSentryOverview> {
  const end = new Date().toISOString();
  const start = new Date(Date.parse(end) - 24 * 60 * 60 * 1000).toISOString();
  const projects = await Promise.all(
    config.projects.map((project) =>
      collectProject(config, project, start, end)
    )
  );
  return {
    status: ApiMonitoringSentryOverviewStatusEnum.Ready,
    environment: config.environment,
    period: '24h',
    fetched_at: new Date().toISOString(),
    window_start: start,
    window_end: end,
    projects
  };
}

// Authorization runs in the monitoring router before this shared snapshot cache.
export async function getSentryOverview(): Promise<ApiMonitoringSentryOverview> {
  const config = getSentryConfig();
  if (!config)
    return {
      status: ApiMonitoringSentryOverviewStatusEnum.NotConfigured,
      environment: '',
      period: '24h',
      projects: []
    };
  const key = `monitoring:sentry:v3:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`;
  const pending = inFlight.get(key);
  if (pending) return await pending;
  const task = redisCached(key, Time.minutes(5), () => collectOverview(config));
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}
