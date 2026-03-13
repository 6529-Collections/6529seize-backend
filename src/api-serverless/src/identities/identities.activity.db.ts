import { DROPS_TABLE, WAVES_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';

const DAY_MS = Time.days(1).toMillis();

export interface IdentityActivityDayCountRow {
  readonly day_bucket: number | string;
  readonly drop_count: number | string;
}

export class IdentitiesActivityDb extends LazyDbAccessCompatibleService {
  public async getPublicWaveDailyDropCounts(
    {
      profileId,
      startInclusive,
      endExclusive
    }: {
      readonly profileId: string;
      readonly startInclusive: number;
      readonly endExclusive: number;
    },
    ctx: RequestContext
  ): Promise<IdentityActivityDayCountRow[]> {
    const timerKey = `${this.constructor.name}->getPublicWaveDailyDropCounts`;
    try {
      ctx.timer?.start(timerKey);
      return await this.db.execute<IdentityActivityDayCountRow>(
        `
          select floor(d.created_at / :dayMs) as day_bucket, count(*) as drop_count
          from ${DROPS_TABLE} d
          join ${WAVES_TABLE} w on w.id = d.wave_id
          where d.author_id = :profileId
            and d.created_at >= :startInclusive
            and d.created_at < :endExclusive
            and w.visibility_group_id is null
            and coalesce(w.is_direct_message, false) = false
          group by 1
          order by 1
        `,
        {
          dayMs: DAY_MS,
          profileId,
          startInclusive,
          endExclusive
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }
}

export const identitiesActivityDb = new IdentitiesActivityDb(dbSupplier);
