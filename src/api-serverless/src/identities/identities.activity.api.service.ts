import { ApiIdentityActivity } from '@/api/generated/models/ApiIdentityActivity';
import {
  identitiesActivityDb,
  IdentitiesActivityDb,
  IdentityActivityDayCountRow
} from '@/api/identities/identities.activity.db';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { NotFoundException } from '@/exceptions';
import { numbers } from '@/numbers';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';

const SAMPLE_DAYS = 365;
const DAY_MS = Time.days(1).toMillis();

export class IdentitiesActivityApiService {
  constructor(
    private readonly identitiesActivityDb: IdentitiesActivityDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly supplyTodayUtcMidnight: () => Time = () =>
      Time.todayUtcMidnight(),
    private readonly supplyNow: () => Time = () => Time.now()
  ) {}

  public async getIdentityActivity(
    { identity }: { readonly identity: string },
    ctx: RequestContext
  ): Promise<ApiIdentityActivity> {
    const profileId = await this.identitiesDb.getProfileIdByIdentityKeyFast(
      { identityKey: identity },
      ctx
    );
    if (!profileId) {
      throw new NotFoundException(`Profile not found for identity ${identity}`);
    }

    const todayUtcMidnight = this.supplyTodayUtcMidnight().toMillis();
    const endExclusive = this.supplyNow().toMillis();
    const startInclusive = todayUtcMidnight - (SAMPLE_DAYS - 1) * DAY_MS;
    const rows = await this.identitiesActivityDb.getPublicWaveDailyDropCounts(
      {
        profileId,
        startInclusive,
        endExclusive
      },
      ctx
    );

    return this.toApiIdentityActivity(rows, startInclusive, todayUtcMidnight);
  }

  private toApiIdentityActivity(
    rows: IdentityActivityDayCountRow[],
    startInclusive: number,
    todayUtcMidnight: number
  ): ApiIdentityActivity {
    const countsByDayBucket = rows.reduce((acc, row) => {
      const dayBucket = numbers.parseIntOrNull(row.day_bucket);
      const dropCount = numbers.parseIntOrNull(row.drop_count);
      if (dayBucket !== null && dropCount !== null) {
        acc.set(dayBucket, dropCount);
      }
      return acc;
    }, new Map<number, number>());

    const startDayBucket = Math.floor(startInclusive / DAY_MS);
    const date_samples = Array.from({ length: SAMPLE_DAYS }, (_, index) => {
      return countsByDayBucket.get(startDayBucket + index) ?? 0;
    });
    const lastDayBucket = Math.floor(todayUtcMidnight / DAY_MS);

    return {
      last_date: this.formatUtcDayBucket(lastDayBucket),
      date_samples
    };
  }

  private formatUtcDayBucket(dayBucket: number): string {
    const date = new Date(dayBucket * DAY_MS);
    return [
      date.getUTCDate().toString().padStart(2, '0'),
      (date.getUTCMonth() + 1).toString().padStart(2, '0'),
      date.getUTCFullYear().toString()
    ].join('.');
  }
}

export const identitiesActivityApiService = new IdentitiesActivityApiService(
  identitiesActivityDb,
  identitiesDb
);
