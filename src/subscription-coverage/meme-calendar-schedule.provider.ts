import { Logger } from '@/logging';

const PRODUCTION_BASE_URL = 'https://6529.io';
const STAGING_BASE_URL = 'https://staging.6529.io';
const DEFAULT_HORIZON = 24;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;
const FETCH_CONCURRENCY = 6;

export interface SubscriptionCoverageScheduledDrop {
  readonly tokenId: number;
  readonly mintAt: string;
  readonly topUpDeadline: null;
}

export interface SubscriptionCoverageSchedule {
  readonly drops: SubscriptionCoverageScheduledDrop[];
  readonly basis: 'PROJECTED';
  readonly deadlineBasis: 'UNAVAILABLE';
  readonly horizon: number;
  readonly truncated: true;
  readonly fetchedAt: string;
}

interface MemeCalendarResponse {
  readonly mint_number: number;
  readonly mint_start: string;
  readonly status: 'past' | 'live' | 'upcoming';
}

interface CachedSchedule {
  readonly expiresAt: number;
  readonly promise: Promise<SubscriptionCoverageSchedule>;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function defaultBaseUrl(): string {
  const sentryEnvironment = process.env.SENTRY_ENVIRONMENT?.toLowerCase() ?? '';
  return process.env.NODE_ENV === 'development' ||
    sentryEnvironment.includes('staging')
    ? STAGING_BASE_URL
    : PRODUCTION_BASE_URL;
}

function parseCalendarResponse(value: unknown): MemeCalendarResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Meme calendar returned a non-object response');
  }
  const record = value as Record<string, unknown>;
  const mintNumber = record.mint_number;
  const mintStart = record.mint_start;
  const status = record.status;
  if (
    typeof mintNumber !== 'number' ||
    !Number.isSafeInteger(mintNumber) ||
    mintNumber <= 0 ||
    typeof mintStart !== 'string' ||
    !Number.isFinite(Date.parse(mintStart)) ||
    (status !== 'past' && status !== 'live' && status !== 'upcoming')
  ) {
    throw new Error('Meme calendar returned an invalid mint response');
  }
  return {
    mint_number: mintNumber,
    mint_start: new Date(mintStart).toISOString(),
    status
  };
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Meme calendar request failed with ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export class MemeCalendarScheduleProvider {
  private readonly logger = Logger.get(MemeCalendarScheduleProvider.name);
  private cache: CachedSchedule | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  public async getSchedule(): Promise<SubscriptionCoverageSchedule> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.promise;
    }

    const ttlMs = parsePositiveInteger(
      process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_TTL_MS,
      DEFAULT_TTL_MS
    );
    const promise = this.fetchSchedule().catch((error) => {
      if (this.cache?.promise === promise) {
        this.cache = null;
      }
      throw error;
    });
    this.cache = { expiresAt: now + ttlMs, promise };
    return promise;
  }

  private async fetchSchedule(): Promise<SubscriptionCoverageSchedule> {
    const baseUrl = normalizeBaseUrl(
      process.env.SUBSCRIPTION_COVERAGE_CALENDAR_BASE_URL ?? defaultBaseUrl()
    );
    const horizon = parsePositiveInteger(
      process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON,
      DEFAULT_HORIZON
    );
    const timeoutMs = parsePositiveInteger(
      process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    );
    const next = parseCalendarResponse(
      await fetchJson(
        `${baseUrl}/api/meme-calendar/next`,
        this.fetchImpl,
        timeoutMs
      )
    );
    const tokenIds = Array.from(
      { length: horizon },
      (_unused, index) => next.mint_number + index
    );
    const calendarDrops = await mapWithConcurrency(
      tokenIds,
      FETCH_CONCURRENCY,
      async (tokenId) =>
        tokenId === next.mint_number
          ? next
          : parseCalendarResponse(
              await fetchJson(
                `${baseUrl}/api/meme-calendar/${tokenId}`,
                this.fetchImpl,
                timeoutMs
              )
            )
    );
    const drops = calendarDrops
      .filter((drop) => drop.status === 'upcoming')
      .map((drop) => ({
        tokenId: drop.mint_number,
        mintAt: drop.mint_start,
        topUpDeadline: null
      }))
      .sort((left, right) => {
        const timeDifference =
          Date.parse(left.mintAt) - Date.parse(right.mintAt);
        return timeDifference || left.tokenId - right.tokenId;
      });

    this.logger.info('Fetched projected Meme subscription schedule', {
      requested_horizon: horizon,
      returned_drops: drops.length
    });
    return {
      drops,
      basis: 'PROJECTED',
      deadlineBasis: 'UNAVAILABLE',
      horizon,
      truncated: true,
      fetchedAt: new Date(this.now()).toISOString()
    };
  }
}

export const memeCalendarScheduleProvider = new MemeCalendarScheduleProvider();
