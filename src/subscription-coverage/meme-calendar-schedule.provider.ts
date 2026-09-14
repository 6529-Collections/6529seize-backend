import { Logger } from '@/logging';

const PRODUCTION_BASE_URL = 'https://6529.io';
const STAGING_BASE_URL = 'https://staging.6529.io';
const DEFAULT_HORIZON = 24;
const MAX_HORIZON = 60;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 30 * 1000;
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
  expiresAt: number;
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
  const configuredEnvironment =
    process.env.SUBSCRIPTION_COVERAGE_ENVIRONMENT?.trim().toLowerCase();
  if (configuredEnvironment === 'staging') {
    return STAGING_BASE_URL;
  }
  if (
    configuredEnvironment === 'production' ||
    configuredEnvironment === 'prod'
  ) {
    return PRODUCTION_BASE_URL;
  }
  if (configuredEnvironment) {
    throw new Error(
      `Invalid SUBSCRIPTION_COVERAGE_ENVIRONMENT '${configuredEnvironment}'`
    );
  }

  switch (process.env.NODE_ENV?.trim().toLowerCase()) {
    case 'local':
    case 'development':
    case 'test':
      return STAGING_BASE_URL;
    case 'production':
      return PRODUCTION_BASE_URL;
    default:
      throw new Error(
        'Subscription coverage calendar environment is not configured'
      );
  }
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

type CalendarFetchResult =
  | { readonly drop: MemeCalendarResponse }
  | { readonly error: unknown; readonly tokenId: number };

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
    const failureTtlMs = parsePositiveInteger(
      process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_FAILURE_TTL_MS,
      DEFAULT_FAILURE_TTL_MS
    );
    const promise = this.fetchSchedule().then(
      (schedule) => {
        if (this.cache?.promise === promise) {
          this.cache.expiresAt = this.now() + ttlMs;
        }
        return schedule;
      },
      (error) => {
        if (this.cache?.promise === promise) {
          this.cache.expiresAt = this.now() + failureTtlMs;
        }
        throw error;
      }
    );
    this.cache = { expiresAt: Number.POSITIVE_INFINITY, promise };
    return promise;
  }

  private async fetchSchedule(): Promise<SubscriptionCoverageSchedule> {
    const baseUrl = normalizeBaseUrl(
      process.env.SUBSCRIPTION_COVERAGE_CALENDAR_BASE_URL ?? defaultBaseUrl()
    );
    const horizon = Math.min(
      parsePositiveInteger(
        process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON,
        DEFAULT_HORIZON
      ),
      MAX_HORIZON
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
    const nextIsUpcoming = next.status === 'upcoming';
    const firstFetchedTokenId = next.mint_number + 1;
    const remainingDropCount = horizon - (nextIsUpcoming ? 1 : 0);
    const tokenIds = Array.from(
      { length: remainingDropCount },
      (_unused, index) => firstFetchedTokenId + index
    );
    const fetchedResults = await mapWithConcurrency(
      tokenIds,
      FETCH_CONCURRENCY,
      async (tokenId): Promise<CalendarFetchResult> => {
        try {
          return {
            drop: parseCalendarResponse(
              await fetchJson(
                `${baseUrl}/api/meme-calendar/${tokenId}`,
                this.fetchImpl,
                timeoutMs
              )
            )
          };
        } catch (error) {
          return { error, tokenId };
        }
      }
    );
    const projectedDrops: MemeCalendarResponse[] = nextIsUpcoming ? [next] : [];
    for (const result of fetchedResults) {
      if ('error' in result) {
        this.logger.warn(
          'Truncated projected Meme subscription schedule after calendar failure',
          {
            token_id: result.tokenId,
            returned_drops: projectedDrops.length,
            error: result.error
          }
        );
        break;
      }
      if (result.drop.status !== 'upcoming') {
        this.logger.warn(
          'Truncated projected Meme subscription schedule at non-upcoming drop',
          {
            token_id: result.drop.mint_number,
            status: result.drop.status,
            returned_drops: projectedDrops.length
          }
        );
        break;
      }
      projectedDrops.push(result.drop);
    }
    const drops = projectedDrops
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
