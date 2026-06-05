import { WAVES_METADATA_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { BadRequestException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export interface WaveMetadata {
  readonly id: number;
  readonly wave_id: string;
  readonly data_key: string;
  readonly data_value: string;
}

type RawWaveMetadata = Omit<WaveMetadata, 'id'> & {
  readonly id: number | string;
};

function getInsertIdFromWriteResult(result: unknown): number {
  if (result != null && typeof result === 'object' && 'insertId' in result) {
    return Number((result as { insertId?: unknown }).insertId ?? 0);
  }
  if (!Array.isArray(result)) {
    return 0;
  }
  const third = result[2] as unknown;
  return typeof third === 'number' ? third : 0;
}

function isDuplicateEntryError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

export class WaveMetadataDb extends LazyDbAccessCompatibleService {
  private toWaveMetadata(row: RawWaveMetadata): WaveMetadata {
    return {
      ...row,
      id: Number(row.id)
    };
  }

  public async listByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<WaveMetadata[]> {
    const timerKey = `${this.constructor.name}->listByWaveId`;
    ctx.timer?.start(timerKey);
    try {
      const rows = await this.db.execute<RawWaveMetadata>(
        `select id, wave_id, data_key, data_value
         from ${WAVES_METADATA_TABLE}
         where wave_id = :waveId
         order by id asc`,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
      return rows.map((row) => this.toWaveMetadata(row));
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findByIdAndWaveId(
    metadataId: number,
    waveId: string,
    ctx: RequestContext
  ): Promise<WaveMetadata | null> {
    const timerKey = `${this.constructor.name}->findByIdAndWaveId`;
    ctx.timer?.start(timerKey);
    try {
      const row = await this.db.oneOrNull<RawWaveMetadata>(
        `select id, wave_id, data_key, data_value
         from ${WAVES_METADATA_TABLE}
         where id = :metadataId and wave_id = :waveId`,
        { metadataId, waveId },
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      return row ? this.toWaveMetadata(row) : null;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async create(
    {
      waveId,
      dataKey,
      dataValue
    }: {
      waveId: string;
      dataKey: string;
      dataValue: string;
    },
    ctx: RequestContext
  ): Promise<WaveMetadata> {
    const timerKey = `${this.constructor.name}->create`;
    ctx.timer?.start(timerKey);
    try {
      const result = await this.db.execute(
        `insert into ${WAVES_METADATA_TABLE}
           (wave_id, data_key, data_value)
         values
           (:waveId, :dataKey, :dataValue)`,
        { waveId, dataKey, dataValue },
        { wrappedConnection: ctx.connection }
      );
      const insertId = getInsertIdFromWriteResult(result);
      if (!insertId) {
        throw new Error('Failed to insert wave metadata');
      }
      return {
        id: insertId,
        wave_id: waveId,
        data_key: dataKey,
        data_value: dataValue
      };
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        throw new BadRequestException(
          `Wave ${waveId} already has metadata for data_key ${dataKey}`
        );
      }
      throw error;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async deleteByIdAndWaveId(
    metadataId: number,
    waveId: string,
    ctx: RequestContext
  ): Promise<WaveMetadata | null> {
    const timerKey = `${this.constructor.name}->deleteByIdAndWaveId`;
    ctx.timer?.start(timerKey);
    try {
      const existing = await this.findByIdAndWaveId(metadataId, waveId, ctx);
      if (!existing) {
        return null;
      }
      const result = await this.db.execute(
        `delete from ${WAVES_METADATA_TABLE}
         where id = :metadataId and wave_id = :waveId`,
        { metadataId, waveId },
        { wrappedConnection: ctx.connection }
      );
      return this.db.getAffectedRows(result) > 0 ? existing : null;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async deleteByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerKey = `${this.constructor.name}->deleteByWaveId`;
    ctx.timer?.start(timerKey);
    try {
      await this.db.execute(
        `delete from ${WAVES_METADATA_TABLE} where wave_id = :waveId`,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }
}

export const waveMetadataDb = new WaveMetadataDb(dbSupplier);
