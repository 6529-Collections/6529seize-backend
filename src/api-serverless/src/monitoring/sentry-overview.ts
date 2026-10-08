import { createHash } from 'node:crypto';
import fetch from 'node-fetch';
import { env } from '@/env';
import { redisCached } from '@/redis';
import { Time } from '@/time';
import { ApiMonitoringSentryIssue } from '@/api/generated/models/ApiMonitoringSentryIssue';
import { ApiMonitoringSentryProjectOverview } from '@/api/generated/models/ApiMonitoringSentryProjectOverview';
import {
  ApiMonitoringSentryOverview,
  ApiMonitoringSentryOverviewStatusEnum
} from '@/api/generated/models/ApiMonitoringSentryOverview';

const SENTRY_ORIGIN = 'https://sentry.io';
const ISSUE_LIMIT = 5;
const inFlight = new Map<string, Promise<ApiMonitoringSentryOverview>>();

interface SentryConfig {
  token: string;
  organization: string;
  projects: string[];
  environment: string;
  environmentFilters: string[];
}

function getConfig(): SentryConfig | null {
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
  const rawCount = scoped.count;
  if (typeof rawCount !== 'string' || !/^\d{1,16}$/.test(rawCount)) {
    throw new Error('Invalid Sentry count');
  }
  const occurrences = Number(rawCount);
  if (!Number.isSafeInteger(occurrences))
    throw new Error('Invalid Sentry count');
  return {
    id,
    short_id: textField(issue.shortId, 100),
    title: textField(issue.title, 180),
    project: textField(record(issue.project).slug, 100),
    occurrences,
    first_seen: dateField(scoped.firstSeen),
    last_seen: dateField(scoped.lastSeen),
    url: `${SENTRY_ORIGIN}/organizations/${encodeURIComponent(organization)}/issues/${id}/`
  };
}

async function fetchIssues(
  config: SentryConfig,
  project: string,
  start: string,
  end: string,
  query: string,
  sort: string
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
  url.searchParams.set('limit', String(ISSUE_LIMIT + 1));
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json'
    },
    timeout: 8_000,
    size: 512_000,
    redirect: 'error'
  });
  if (!response.ok) throw new Error('Sentry request failed');
  const body: unknown = await response.json();
  if (!Array.isArray(body) || body.length > ISSUE_LIMIT + 1)
    throw new Error('Invalid Sentry issues');
  return {
    issues: body
      .slice(0, ISSUE_LIMIT)
      .map((issue: unknown) => parseIssue(issue, config.organization)),
    hasMore: body.length > ISSUE_LIMIT
  };
}

async function collectProject(
  config: SentryConfig,
  project: string,
  start: string,
  end: string
): Promise<ApiMonitoringSentryProjectOverview> {
  const [newIssues, topIssues] = await Promise.all([
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
    )
  ]);
  return {
    project,
    new_issues: newIssues.issues,
    top_issues: topIssues.issues,
    new_issues_has_more: newIssues.hasMore,
    top_issues_has_more: topIssues.hasMore
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
  const config = getConfig();
  if (!config)
    return {
      status: ApiMonitoringSentryOverviewStatusEnum.NotConfigured,
      environment: '',
      period: '24h',
      projects: []
    };
  const key = `monitoring:sentry:v2:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`;
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
