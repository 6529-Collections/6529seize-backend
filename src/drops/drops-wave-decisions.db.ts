import {
  DROPS_TABLE,
  IDENTITIES_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export interface IDropsDbForWaveDecisions {
  resyncParticipatoryDropCountsForWaves(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<void>;
  getDropAuthorHandle(
    dropId: string,
    ctx: RequestContext
  ): Promise<string | null>;
}

export class DropsDbForWaveDecisions
  extends LazyDbAccessCompatibleService
  implements IDropsDbForWaveDecisions
{
  public async resyncParticipatoryDropCountsForWaves(
    waveIds: string[],
    ctx: RequestContext
  ) {
    if (!waveIds.length) {
      return;
    }
    ctx.timer?.start('dropsDb->resyncParticipatoryDropCountsForWaves');
    await Promise.all([
      this.db.execute(
        `
            update ${WAVE_DROPPER_METRICS_TABLE}
                left join (select wave_id, author_id, count(*) participatory_drops_count
                           from ${DROPS_TABLE}
                           where drop_type = 'PARTICIPATORY' and wave_id in (:waveIds)
                           group by wave_id, author_id) actual on ${WAVE_DROPPER_METRICS_TABLE}.wave_id = actual.wave_id and
                                                                  ${WAVE_DROPPER_METRICS_TABLE}.dropper_id = actual.author_id
            set ${WAVE_DROPPER_METRICS_TABLE}.participatory_drops_count = ifnull(actual.participatory_drops_count, 0)
            where ${WAVE_DROPPER_METRICS_TABLE}.wave_id in (:waveIds) 
              and ${WAVE_DROPPER_METRICS_TABLE}.participatory_drops_count <> ifnull(actual.participatory_drops_count, 0)
        `,
        { waveIds },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute(
        `
        update ${WAVE_METRICS_TABLE}
                left join (select wave_id, count(*) participatory_drops_count
                           from ${DROPS_TABLE}
                           where drop_type = 'PARTICIPATORY' and wave_id in (:waveIds)
                           group by wave_id) actual on ${WAVE_METRICS_TABLE}.wave_id = actual.wave_id
            set ${WAVE_METRICS_TABLE}.participatory_drops_count = ifnull(actual.participatory_drops_count, 0)
            where ${WAVE_METRICS_TABLE}.wave_id in (:waveIds) 
              and ${WAVE_METRICS_TABLE}.participatory_drops_count <> ifnull(actual.participatory_drops_count, 0)
        `,
        { waveIds },
        { wrappedConnection: ctx.connection }
      )
    ]);
    ctx.timer?.stop('dropsDb->resyncParticipatoryDropCountsForWaves');
  }

  async getDropAuthorHandle(
    dropId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    return await this.db
      .oneOrNull<{ handle: string }>(
        `
        select i.handle as handle from ${DROPS_TABLE} d
        join ${IDENTITIES_TABLE} i on i.profile_id = d.author_id
        where d.id = :dropId
      `,
        { dropId },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it?.handle ?? null);
  }
}

export const dropsDbForWaveDecisions = new DropsDbForWaveDecisions(dbSupplier);
