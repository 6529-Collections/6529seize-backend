import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import {
  DROP_CURATIONS_TABLE,
  USER_GROUPS_TABLE,
  WAVE_CURATIONS_TABLE
} from '@/constants';
import { DropCurationEntity } from '@/entities/IDropCuration';
import { WaveCurationEntity } from '@/entities/IWaveCuration';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';

export class CurationsDb extends LazyDbAccessCompatibleService {
  public async findWaveCurationById(
    param: { id: string; wave_id?: string },
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationEntity | null> {
    return await this.db.oneOrNull<WaveCurationEntity>(
      `
      select * from ${WAVE_CURATIONS_TABLE}
      where id = :id ${param.wave_id ? 'and wave_id = :wave_id' : ''}
      `,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findWaveCurationsByWaveId(
    waveId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationEntity[]> {
    return await this.db.execute<WaveCurationEntity>(
      `
      select * from ${WAVE_CURATIONS_TABLE}
      where wave_id = :waveId
      order by created_at asc
      `,
      { waveId },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findWaveCurationsByWaveIds(
    waveIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationEntity[]> {
    if (!waveIds.length) {
      return [];
    }
    return await this.db.execute<WaveCurationEntity>(
      `
      select * from ${WAVE_CURATIONS_TABLE}
      where wave_id in (:waveIds)
      `,
      { waveIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findWaveCurationByName(
    param: { wave_id: string; name: string },
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationEntity | null> {
    return await this.db.oneOrNull<WaveCurationEntity>(
      `
      select * from ${WAVE_CURATIONS_TABLE}
      where wave_id = :wave_id and name = :name
      `,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async insertWaveCuration(
    entity: WaveCurationEntity,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->insertWaveCuration`);
      await this.db.execute(
        `
        insert into ${WAVE_CURATIONS_TABLE}
        (id, name, wave_id, community_group_id, created_at, updated_at)
        values
        (:id, :name, :wave_id, :community_group_id, :created_at, :updated_at)
      `,
        entity,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->insertWaveCuration`);
    }
  }

  public async updateWaveCuration(
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
      ctx.timer?.start(`${this.constructor.name}->updateWaveCuration`);
      await this.db.execute(
        `
        update ${WAVE_CURATIONS_TABLE}
        set name = :name, community_group_id = :community_group_id, updated_at = :updated_at
        where id = :id and wave_id = :wave_id
      `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateWaveCuration`);
    }
  }

  public async deleteWaveCuration(
    param: { id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteWaveCuration`);
      await this.db.execute(
        `
        delete from ${WAVE_CURATIONS_TABLE}
        where id = :id and wave_id = :wave_id
      `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteWaveCuration`);
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
    param: {
      drop_id: string;
      curation_id: string;
      curated_by: string;
      wave_id: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->upsertDropCuration`);
      const now = Time.currentMillis();
      await this.db.execute(
        `
        insert into ${DROP_CURATIONS_TABLE}
        (drop_id, curation_id, curated_by, created_at, updated_at, wave_id)
        values
        (:drop_id, :curation_id, :curated_by, :created_at, :updated_at, :wave_id)
        on duplicate key update
          curated_by = values(curated_by),
          updated_at = values(updated_at)
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
    param: { drop_id: string; curation_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteDropCuration`);
      await this.db.execute(
        `
        delete from ${DROP_CURATIONS_TABLE}
        where drop_id = :drop_id and curation_id = :curation_id
      `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteDropCuration`);
    }
  }

  public async findCuratedDropIdsByCurations(
    param: { dropIds: string[]; curationIds: string[] },
    connection?: ConnectionWrapper<any>
  ): Promise<Set<string>> {
    if (!param.dropIds.length || !param.curationIds.length) {
      return new Set<string>();
    }
    const rows = await this.db.execute<{ drop_id: string }>(
      `
      select distinct drop_id from ${DROP_CURATIONS_TABLE}
      where drop_id in (:dropIds) and curation_id in (:curationIds)
      `,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
    return new Set(rows.map((it) => it.drop_id));
  }

  public async findCurationIdsForDropId(
    dropId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<Set<string>> {
    const rows = await this.db.execute<{ curation_id: string }>(
      `
      select distinct curation_id
      from ${DROP_CURATIONS_TABLE}
      where drop_id = :dropId
      `,
      { dropId },
      connection ? { wrappedConnection: connection } : undefined
    );
    return new Set(rows.map((it) => it.curation_id));
  }

  public async findWaveCurationsForDropId(
    dropId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveCurationEntity[]> {
    return await this.db.execute<WaveCurationEntity>(
      `
      select wcg.*
      from ${WAVE_CURATIONS_TABLE} wcg
      join ${DROP_CURATIONS_TABLE} dc on dc.curation_id = wcg.id
      where dc.drop_id = :dropId
      order by wcg.created_at asc, wcg.id asc
      `,
      { dropId },
      connection ? { wrappedConnection: connection } : undefined
    );
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

  public async deleteWaveCurationsByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteWaveCurationsByWaveId`);
      await this.db.execute(
        `
        delete from ${WAVE_CURATIONS_TABLE}
        where wave_id = :waveId
      `,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteWaveCurationsByWaveId`);
    }
  }

  public async deleteDropCurationsByCurationId(
    curationId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->deleteDropCurationsByCurationId`
      );
      await this.db.execute(
        `
        delete from ${DROP_CURATIONS_TABLE}
        where curation_id = :curationId
      `,
        { curationId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->deleteDropCurationsByCurationId`
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
        update ${DROP_CURATIONS_TABLE}
        set curated_by = :new_id
        where curated_by = :previous_id
      `,
        param,
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
