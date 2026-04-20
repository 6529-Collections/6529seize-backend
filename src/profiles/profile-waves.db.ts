import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { PROFILE_WAVES_TABLE, WAVE_CURATIONS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { ProfileWaveEntity } from '@/entities/IProfileWave';

export interface EffectiveProfileWave {
  readonly profile_wave_id: string;
  readonly profile_curation_id: string | null;
}

export class ProfileWavesDb extends LazyDbAccessCompatibleService {
  public async findProfileWaveIdsByProfileIds(
    profileIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, string>> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->findProfileWaveIdsByProfileIds`
      );
      if (!profileIds.length) {
        return {};
      }
      const rows = await this.db.execute<ProfileWaveEntity>(
        `
          select profile_id, wave_id
          from ${PROFILE_WAVES_TABLE}
          where profile_id in (:profileIds)
        `,
        { profileIds },
        { wrappedConnection: ctx.connection }
      );
      return rows.reduce(
        (acc, row) => {
          acc[row.profile_id] = row.wave_id;
          return acc;
        },
        {} as Record<string, string>
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->findProfileWaveIdsByProfileIds`
      );
    }
  }

  public async findSelectedWaveIdsByWaveIds(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Set<string>> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->findSelectedWaveIdsByWaveIds`
      );
      if (!waveIds.length) {
        return new Set<string>();
      }
      const rows = await this.db.execute<{ wave_id: string }>(
        `
          select wave_id
          from ${PROFILE_WAVES_TABLE}
          where wave_id in (:waveIds)
        `,
        { waveIds },
        { wrappedConnection: ctx.connection }
      );
      return new Set(rows.map((row) => row.wave_id));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findSelectedWaveIdsByWaveIds`);
    }
  }

  public async setProfileWave(
    {
      profileId,
      waveId,
      profileCurationId
    }: {
      profileId: string;
      waveId: string;
      profileCurationId: string | null;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->setProfileWave`);
      await this.db.execute(
        `
          delete from ${PROFILE_WAVES_TABLE}
          where profile_id = :profileId or wave_id = :waveId
        `,
        { profileId, waveId },
        { wrappedConnection: ctx.connection }
      );
      await this.db.execute(
        `
          insert into ${PROFILE_WAVES_TABLE} (profile_id, wave_id, profile_curation_id)
          values (:profileId, :waveId, :profileCurationId)
        `,
        { profileId, waveId, profileCurationId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->setProfileWave`);
    }
  }

  public async deleteByProfileId(
    profileId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteByProfileId`);
      await this.db.execute(
        `
          delete from ${PROFILE_WAVES_TABLE}
          where profile_id = :profileId
        `,
        { profileId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteByProfileId`);
    }
  }

  public async deleteByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteByWaveId`);
      await this.db.execute(
        `
          delete from ${PROFILE_WAVES_TABLE}
          where wave_id = :waveId
        `,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteByWaveId`);
    }
  }

  public async clearProfileCurationByCurationId(
    curationId: string,
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->clearProfileCurationByCurationId`
      );
      await this.db.execute(
        `
          update ${PROFILE_WAVES_TABLE}
          set profile_curation_id = null
          where profile_curation_id = :curationId
        `,
        { curationId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->clearProfileCurationByCurationId`
      );
    }
  }

  public async findByWaveId(
    waveId: string,
    ctx: RequestContext
  ): Promise<ProfileWaveEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findByWaveId`);
      return await this.db.oneOrNull<ProfileWaveEntity>(
        `
          select profile_id, wave_id, profile_curation_id
          from ${PROFILE_WAVES_TABLE}
          where wave_id = :waveId
        `,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findByWaveId`);
    }
  }

  public async mergeOnProfileIdChange(
    {
      previous_id,
      new_id
    }: {
      previous_id: string;
      new_id: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->mergeOnProfileIdChange`);
      if (previous_id === new_id) {
        return;
      }
      const rows = await this.db.execute<ProfileWaveEntity>(
        `
          select profile_id, wave_id, profile_curation_id
          from ${PROFILE_WAVES_TABLE}
          where profile_id in (:profileIds)
        `,
        { profileIds: [previous_id, new_id] },
        { wrappedConnection: ctx.connection }
      );
      const source = rows.find((row) => row.profile_id === previous_id) ?? null;
      const target = rows.find((row) => row.profile_id === new_id) ?? null;
      if (!source) {
        return;
      }
      if (target) {
        await this.deleteByProfileId(previous_id, ctx);
        return;
      }
      await this.db.execute(
        `
          update ${PROFILE_WAVES_TABLE}
          set profile_id = :new_id
          where profile_id = :previous_id
        `,
        { previous_id, new_id },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->mergeOnProfileIdChange`);
    }
  }

  public async findByProfileId(
    profileId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<ProfileWaveEntity | null> {
    return await this.db.oneOrNull<ProfileWaveEntity>(
      `
        select profile_id, wave_id, profile_curation_id
        from ${PROFILE_WAVES_TABLE}
        where profile_id = :profileId
      `,
      { profileId },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async findEffectiveProfileWaveByProfileId(
    profileId: string,
    ctx: RequestContext
  ): Promise<EffectiveProfileWave | null> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->findEffectiveProfileWaveByProfileId`
      );
      return await this.db.oneOrNull<EffectiveProfileWave>(
        `
          select
            pw.wave_id as profile_wave_id,
            coalesce(selected_curation.id, fallback_curation.id) as profile_curation_id
          from ${PROFILE_WAVES_TABLE} pw
          left join ${WAVE_CURATIONS_TABLE} selected_curation
            on selected_curation.id = pw.profile_curation_id
            and selected_curation.wave_id = pw.wave_id
          left join ${WAVE_CURATIONS_TABLE} fallback_curation
            on fallback_curation.id = (
              select wcg.id
              from ${WAVE_CURATIONS_TABLE} wcg
              where wcg.wave_id = pw.wave_id
              order by wcg.created_at asc, wcg.id asc
              limit 1
            )
          where pw.profile_id = :profileId
        `,
        { profileId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->findEffectiveProfileWaveByProfileId`
      );
    }
  }
}

export const profileWavesDb = new ProfileWavesDb(dbSupplier);
