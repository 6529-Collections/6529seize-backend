import { randomUUID } from 'node:crypto';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CAPABILITY_AUDITS_TABLE
} from '@/constants';
import { CompetitionCapability } from '@/entities/ICompetition';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { competitionConflict } from './competition-command.repository';

export interface CompetitionCapabilityChange {
  waveId: string;
  competitionId: string;
  capability: CompetitionCapability;
  action: 'assign' | 'remove';
  actorId: string;
  reason: string;
}

export class CompetitionCapabilityRepository extends LazyDbAccessCompatibleService {
  public async change(
    change: CompetitionCapabilityChange,
    dryRun: boolean,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->change`;
    ctx.timer?.start(timerName);
    try {
      if (!ctx.connection)
        throw new Error(
          'Capability changes require a locked competition transaction'
        );
      const options = { wrappedConnection: ctx.connection };
      const existing = await this.db.oneOrNull<{ competition_id: string }>(
        `SELECT competition_id FROM ${COMPETITION_CAPABILITIES_TABLE} WHERE competition_id = :competitionId AND capability = :capability`,
        change,
        options
      );
      if ((change.action === 'assign') === Boolean(existing))
        competitionConflict('The capability is already in the requested state');
      if (dryRun) return;
      const now = Date.now();
      if (change.action === 'assign') {
        await this.db.execute(
          `INSERT INTO ${COMPETITION_CAPABILITIES_TABLE}
          (capability,competition_id,wave_id,assigned_by,legacy_source_wave_id,assigned_at)
          VALUES (:capability,:competitionId,:waveId,:actorId,NULL,:now)`,
          { ...change, now },
          options
        );
      } else {
        await this.db.execute(
          `DELETE FROM ${COMPETITION_CAPABILITIES_TABLE} WHERE competition_id = :competitionId AND capability = :capability`,
          change,
          options
        );
      }
      await this.db.execute(
        `INSERT INTO ${COMPETITION_CAPABILITY_AUDITS_TABLE}
        (id,competition_id,capability,action,actor_id,reason,created_at)
        VALUES (:id,:competitionId,:capability,:action,:actorId,:reason,:now)`,
        { ...change, id: randomUUID(), now },
        options
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const competitionCapabilityRepository =
  new CompetitionCapabilityRepository(dbSupplier);
