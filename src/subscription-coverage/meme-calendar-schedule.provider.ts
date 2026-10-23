import {
  getMintTimelineDetails,
  getNextMintTimelineDetails
} from '@/memes-calendar';

const DEFAULT_HORIZON = 24;
const MAX_HORIZON = 60;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

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

interface CachedSchedule {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly schedule: SubscriptionCoverageSchedule;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class MemeCalendarScheduleProvider {
  private cache: CachedSchedule | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  public async getSchedule(): Promise<SubscriptionCoverageSchedule> {
    const now = this.now();
    if (
      this.cache &&
      now >= this.cache.createdAt &&
      now < this.cache.expiresAt
    ) {
      return this.cache.schedule;
    }
    const horizon = Math.min(
      parsePositiveInteger(
        process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON,
        DEFAULT_HORIZON
      ),
      MAX_HORIZON
    );
    const next = getNextMintTimelineDetails(new Date(now));
    const drops = Array.from({ length: horizon }, (_, index) => {
      const mint =
        index === 0 ? next : getMintTimelineDetails(next.mintNumber + index);
      return {
        tokenId: mint.mintNumber,
        mintAt: mint.instantUtc.toISOString(),
        topUpDeadline: null
      };
    });
    const schedule: SubscriptionCoverageSchedule = {
      drops,
      basis: 'PROJECTED',
      deadlineBasis: 'UNAVAILABLE',
      horizon,
      truncated: true,
      fetchedAt: new Date(now).toISOString()
    };
    const ttlMs = parsePositiveInteger(
      process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_TTL_MS,
      DEFAULT_TTL_MS
    );
    this.cache = {
      createdAt: now,
      expiresAt: Math.min(now + ttlMs, next.instantUtc.getTime()),
      schedule
    };
    return schedule;
  }
}

export const memeCalendarScheduleProvider = new MemeCalendarScheduleProvider();
