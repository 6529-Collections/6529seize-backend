import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import {
  DROP_CURATIONS_TABLE,
  USER_GROUPS_TABLE,
  WAVE_CURATION_GROUPS_TABLE
} from '@/constants';
import { DropCurationEntity } from '@/entities/IDropCuration';
import { WaveCurationGroupEntity } from '@/entities/IWaveCurationGroup';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';

export class CurationsDb extends LazyDbAccessCompatibleService {
  public async findWaveCurationGroupById(
    param: { id: string; wave_id: string },
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationGroupEntity | null> {
    return await this.db.oneOrNull<WaveCurationGroupEntity>(
      `
      select * from ${WAVE_CURATION_GROUPS_TABLE}
      where id = :id and wave_id = :wave_id
      `,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findWaveCurationGroupsByWaveId(
    waveId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationGroupEntity[]> {
    return await this.db.execute<WaveCurationGroupEntity>(
      `
      select * from ${WAVE_CURATION_GROUPS_TABLE}
      where wave_id = :waveId
      order by created_at asc
      `,
      { waveId },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findWaveCurationGroupsByWaveIds(
    waveIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationGroupEntity[]> {
    if (!waveIds.length) {
      return [];
    }
    return await this.db.execute<WaveCurationGroupEntity>(
      `
      select * from ${WAVE_CURATION_GROUPS_TABLE}
      where wave_id in (:waveIds)
      `,
      { waveIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findWaveCurationGroupByName(
    param: { wave_id: string; name: string },
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationGroupEntity | null> {
    return await this.db.oneOrNull<WaveCurationGroupEntity>(
      `
      select * from ${WAVE_CURATION_GROUPS_TABLE}
      where wave_id = :wave_id and name = :name
      `,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async insertWaveCurationGroup(
    entity: WaveCurationGroupEntity,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->insertWaveCurationGroup`);
      await this.db.execute(
        `
        insert into ${WAVE_CURATION_GROUPS_TABLE}
        (id, name, wave_id, community_group_id, created_at, updated_at)
        values
        (:id, :name, :wave_id, :community_group_id, :created_at, :updated_at)
      `,
        entity,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->insertWaveCurationGroup`);
    }
  }

  public async updateWaveCurationGroup(
    param: {
      id: string;
      wave_id: string;
      name: string;
      community_group_id: string;
      updated_at: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateWaveCurationGroup`);
      await this.db.execute(
        `
        update ${WAVE_CURATION_GROUPS_TABLE}
        set name = :name, community_group_id = :community_group_id, updated_at = :updated_at
        where id = :id and wave_id = :wave_id
      `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateWaveCurationGroup`);
    }
  }

  public async deleteWaveCurationGroup(
    param: { id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteWaveCurationGroup`);
      await this.db.execute(
        `
        delete from ${WAVE_CURATION_GROUPS_TABLE}
        where id = :id and wave_id = :wave_id
      `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteWaveCurationGroup`);
    }
  }

  public async findCommunityGroupById(
    groupId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<{ id: string; is_private: boolean } | null> {
    return await this.db.oneOrNull<{ id: string; is_private: boolean }>(
      `
      select id, is_private from ${USER_GROUPS_TABLE}
      where id = :groupId
      `,
      { groupId },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async upsertDropCuration(
    param: { drop_id: string; curator_id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->upsertDropCuration`);
      const now = Time.currentMillis();
      await this.db.execute(
        `
        insert into ${DROP_CURATIONS_TABLE}
        (drop_id, curator_id, curator_rating, created_at, updated_at, wave_id)
        values
        (:drop_id, :curator_id, 1, :created_at, :updated_at, :wave_id)
        on duplicate key update drop_id = values(drop_id)
      `,
        {
          ...param,
          created_at: now,
          updated_at: now
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->upsertDropCuration`);
    }
  }

  public async deleteDropCuration(
    param: { drop_id: string; curator_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteDropCuration`);
      await this.db.execute(
        `
        delete from ${DROP_CURATIONS_TABLE}
        where drop_id = :drop_id and curator_id = :curator_id
      `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteDropCuration`);
    }
  }

  public async findCuratedDropIdsByCurator(
    param: { dropIds: string[]; curatorId: string },
    connection?: ConnectionWrapper<any>
  ): Promise<Set<string>> {
    if (!param.dropIds.length) {
      return new Set<string>();
    }
    const rows = await this.db.execute<{ drop_id: string }>(
      `
      select drop_id from ${DROP_CURATIONS_TABLE}
      where drop_id in (:dropIds) and curator_id = :curatorId
      `,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
    return new Set(rows.map((it) => it.drop_id));
  }

  public async findCuratorIdsByDropId(
    param: {
      drop_id: string;
      limit: number;
      offset: number;
      sort_order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<string[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findCuratorIdsByDropId`);
      const rows = await this.db.execute<{ curator_id: string }>(
        `
        select curator_id
        from ${DROP_CURATIONS_TABLE}
        where drop_id = :drop_id
        order by created_at ${param.sort_order}, curator_id asc
        limit :limit
        offset :offset
      `,
        param,
        { wrappedConnection: ctx.connection }
      );
      return rows.map((it) => it.curator_id);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findCuratorIdsByDropId`);
    }
  }

  public async countCurationsByDropId(
    dropId: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countCurationsByDropId`);
      const rows = await this.db.execute<{ count: number }>(
        `
        select count(*) as count
        from ${DROP_CURATIONS_TABLE}
        where drop_id = :dropId
      `,
        { dropId },
        { wrappedConnection: ctx.connection }
      );
      return rows[0]?.count ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countCurationsByDropId`);
    }
  }

  public async deleteDropCurationsByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteDropCurationsByWaveId`);
      await this.db.execute(
        `
        delete from ${DROP_CURATIONS_TABLE}
        where wave_id = :waveId
      `,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteDropCurationsByWaveId`);
    }
  }

  public async deleteWaveCurationGroupsByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->deleteWaveCurationGroupsByWaveId`
      );
      await this.db.execute(
        `
        delete from ${WAVE_CURATION_GROUPS_TABLE}
        where wave_id = :waveId
      `,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->deleteWaveCurationGroupsByWaveId`
      );
    }
  }

  public async deleteDropCurationsByDropId(
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteDropCurationsByDropId`);
      await this.db.execute(
        `
        delete from ${DROP_CURATIONS_TABLE}
        where drop_id = :dropId
      `,
        { dropId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteDropCurationsByDropId`);
    }
  }

  public async mergeOnProfileIdChange(
    param: { previous_id: string; new_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->mergeOnProfileIdChange`);
      await this.db.execute(
        `
        insert into ${DROP_CURATIONS_TABLE}
        (drop_id, curator_id, curator_rating, created_at, updated_at, wave_id)
        select
          source_curations.drop_id,
          :new_id as curator_id,
          source_curations.curator_rating,
          source_curations.created_at,
          source_curations.updated_at,
          source_curations.wave_id
        from ${DROP_CURATIONS_TABLE} source_curations
        where source_curations.curator_id = :previous_id
        on duplicate key update
          curator_rating = greatest(${DROP_CURATIONS_TABLE}.curator_rating, values(curator_rating)),
          created_at = least(${DROP_CURATIONS_TABLE}.created_at, values(created_at)),
          updated_at = greatest(${DROP_CURATIONS_TABLE}.updated_at, values(updated_at))
      `,
        param,
        { wrappedConnection: ctx.connection }
      );
      await this.db.execute(
        `
        delete from ${DROP_CURATIONS_TABLE}
        where curator_id = :previous_id
      `,
        { previous_id: param.previous_id },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->mergeOnProfileIdChange`);
    }
  }

  public async findDropCurationsByDropIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropCurationEntity[]> {
    if (!dropIds.length) {
      return [];
    }
    return await this.db.execute<DropCurationEntity>(
      `
      select * from ${DROP_CURATIONS_TABLE}
      where drop_id in (:dropIds)
      `,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }
}

export const curationsDb = new CurationsDb(dbSupplier);
