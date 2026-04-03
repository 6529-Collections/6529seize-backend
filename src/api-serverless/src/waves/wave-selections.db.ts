import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { WAVE_SELECTION_DROPS_TABLE, WAVE_SELECTIONS_TABLE } from '@/constants';
import {
  WaveSelectionDropEntity,
  WaveSelectionEntity
} from '@/entities/IWaveSelection';
import { RequestContext } from '@/request.context';

export class WaveSelectionsDb extends LazyDbAccessCompatibleService {
  public async findWaveSelectionById(
    param: { id: string; wave_id?: string },
    connection?: ConnectionWrapper<any>
  ): Promise<WaveSelectionEntity | null> {
    return await this.db.oneOrNull<WaveSelectionEntity>(
      `
      select * from ${WAVE_SELECTIONS_TABLE}
      where id = :id ${param.wave_id ? 'and wave_id = :wave_id' : ''}
      `,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findWaveSelectionsByWaveIds(
    waveIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<WaveSelectionEntity[]> {
    if (!waveIds.length) {
      return [];
    }
    return await this.db.execute<WaveSelectionEntity>(
      `
      select * from ${WAVE_SELECTIONS_TABLE}
      where wave_id in (:waveIds)
      order by wave_id asc, created_at asc, id asc
      `,
      { waveIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findWaveSelectionsByDropIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Array<{ drop_id: string; id: string; title: string }>> {
    if (!dropIds.length) {
      return [];
    }
    return await this.db.execute<{
      drop_id: string;
      id: string;
      title: string;
    }>(
      `
      select
        wsd.drop_id,
        ws.id,
        ws.title
      from ${WAVE_SELECTION_DROPS_TABLE} wsd
      join ${WAVE_SELECTIONS_TABLE} ws on ws.id = wsd.selection_id
      where wsd.drop_id in (:dropIds)
      order by wsd.drop_id asc, ws.created_at asc, ws.id asc
      `,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async insertWaveSelection(
    entity: WaveSelectionEntity,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->insertWaveSelection`);
      await this.db.execute(
        `
        insert into ${WAVE_SELECTIONS_TABLE}
        (id, title, wave_id, created_at, updated_at)
        values
        (:id, :title, :wave_id, :created_at, :updated_at)
        `,
        entity,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->insertWaveSelection`);
    }
  }

  public async deleteWaveSelection(
    param: { id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteWaveSelection`);
      await this.db.execute(
        `
        delete from ${WAVE_SELECTIONS_TABLE}
        where id = :id and wave_id = :wave_id
        `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteWaveSelection`);
    }
  }

  public async upsertWaveSelectionDrop(
    entity: WaveSelectionDropEntity,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->upsertWaveSelectionDrop`);
      await this.db.execute(
        `
        insert into ${WAVE_SELECTION_DROPS_TABLE}
        (selection_id, drop_id, wave_id, created_at, updated_at)
        values
        (:selection_id, :drop_id, :wave_id, :created_at, :updated_at)
        on duplicate key update
          wave_id = values(wave_id),
          updated_at = values(updated_at)
        `,
        entity,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->upsertWaveSelectionDrop`);
    }
  }

  public async deleteWaveSelectionDrop(
    param: { selection_id: string; drop_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteWaveSelectionDrop`);
      await this.db.execute(
        `
        delete from ${WAVE_SELECTION_DROPS_TABLE}
        where selection_id = :selection_id and drop_id = :drop_id
        `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteWaveSelectionDrop`);
    }
  }

  public async deleteWaveSelectionDropsBySelectionId(
    selectionId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->deleteWaveSelectionDropsBySelectionId`
      );
      await this.db.execute(
        `
        delete from ${WAVE_SELECTION_DROPS_TABLE}
        where selection_id = :selectionId
        `,
        { selectionId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->deleteWaveSelectionDropsBySelectionId`
      );
    }
  }

  public async deleteWaveSelectionDropsByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->deleteWaveSelectionDropsByWaveId`
      );
      await this.db.execute(
        `
        delete from ${WAVE_SELECTION_DROPS_TABLE}
        where wave_id = :waveId
        `,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->deleteWaveSelectionDropsByWaveId`
      );
    }
  }

  public async deleteWaveSelectionDropsByDropId(
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->deleteWaveSelectionDropsByDropId`
      );
      await this.db.execute(
        `
        delete from ${WAVE_SELECTION_DROPS_TABLE}
        where drop_id = :dropId
        `,
        { dropId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->deleteWaveSelectionDropsByDropId`
      );
    }
  }

  public async deleteWaveSelectionsByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->deleteWaveSelectionsByWaveId`
      );
      await this.db.execute(
        `
        delete from ${WAVE_SELECTIONS_TABLE}
        where wave_id = :waveId
        `,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteWaveSelectionsByWaveId`);
    }
  }
}

export const waveSelectionsDb = new WaveSelectionsDb(dbSupplier);
