import {
  COMPETITIONS_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

// Old decision workers require a finite end time. This value keeps them paused
// until an explicit resume without changing their execution contract.
export const LEGACY_INDEFINITE_PAUSE_END = 253402300799000;

export class LegacyCompetitionSettingsRepository extends LazyDbAccessCompatibleService {
  public async hasVotes(waveId: string, ctx: RequestContext) {
    return Boolean(
      await this.db.oneOrNull<{ id: number }>(
        `SELECT id FROM ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} WHERE wave_id = :waveId LIMIT 1`,
        { waveId },
        { wrappedConnection: ctx.connection }
      )
    );
  }

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

  public async resume(waveId: string, now: number, ctx: RequestContext) {
    const pauses = await this.db.execute<{ id: number }>(
      `SELECT id FROM ${WAVES_DECISION_PAUSES_TABLE} WHERE wave_id = :waveId AND start_time <= :now AND end_time > :now FOR UPDATE`,
      { waveId, now },
      { wrappedConnection: ctx.connection }
    );
    if (!pauses.length) return false;
    // Retain the pause record and its reason as history.
    await this.db.execute(
      `UPDATE ${WAVES_DECISION_PAUSES_TABLE} SET end_time = :now WHERE id IN (:ids)`,
      { ids: pauses.map((pause) => pause.id), now },
      { wrappedConnection: ctx.connection }
    );
    return true;
  }
}

export const legacyCompetitionSettingsRepository =
  new LegacyCompetitionSettingsRepository(dbSupplier);
