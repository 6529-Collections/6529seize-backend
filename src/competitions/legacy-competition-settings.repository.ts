import {
  COMPETITIONS_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

// Old decision workers require a finite end time. This value keeps them paused
// until an explicit resume without changing their execution contract.
export const LEGACY_INDEFINITE_PAUSE_END = 253402300799000;

export class LegacyCompetitionSettingsRepository extends LazyDbAccessCompatibleService {
  public async advanceVersion(
    competitionId: string,
    version: number,
    ctx: RequestContext
  ) {
    await this.db.execute(
      `UPDATE ${COMPETITIONS_TABLE} SET config_version = config_version + 1, updated_at = :version WHERE id = :competitionId`,
      { competitionId, version },
      { wrappedConnection: ctx.connection }
    );
  }

  public async advanceWaveVersion(
    waveId: string,
    version: number,
    ctx: RequestContext
  ) {
    await this.db.execute(
      `UPDATE ${WAVES_TABLE} SET updated_at = :version WHERE id = :waveId`,
      { waveId, version },
      { wrappedConnection: ctx.connection }
    );
  }

  public async pause(
    waveId: string,
    start: number,
    end: number,
    reason: string,
    ctx: RequestContext
  ) {
    await this.db.execute(
      `UPDATE ${WAVES_DECISION_PAUSES_TABLE} SET reason = :reason WHERE wave_id = :waveId AND start_time = :start AND end_time = :end`,
      { waveId, start, end, reason },
      { wrappedConnection: ctx.connection }
    );
  }

  public async resume(waveId: string, now: number, ctx: RequestContext) {
    // Retain the pause record and its reason as history.
    await this.db.execute(
      `UPDATE ${WAVES_DECISION_PAUSES_TABLE} SET end_time = :now WHERE wave_id = :waveId AND start_time <= :now AND end_time > :now`,
      { waveId, now },
      { wrappedConnection: ctx.connection }
    );
  }
}

export const legacyCompetitionSettingsRepository =
  new LegacyCompetitionSettingsRepository(dbSupplier);
