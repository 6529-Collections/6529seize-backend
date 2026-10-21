import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  Competition,
  CompetitionEntry
} from '@/competitions/competition.types';

export type CompetitionCreditNamespace = Pick<
  Competition,
  'id' | 'wave_id' | 'storage_mode'
>;

export type CompetitionCreditSpending = {
  readonly namespace_spent: number;
  readonly entry_spent: number;
  readonly current_vote: number;
};

/** Reads current encumbrances, not historical credit-spending deltas. */
export class CompetitionCreditRepository extends LazyDbAccessCompatibleService {
  public async getNamespaceSpendings(
    competition: CompetitionCreditNamespace,
    profileIds: readonly string[],
    ctx: RequestContext
  ): Promise<Map<string, number>> {
    const timerName = `${this.constructor.name}->getNamespaceSpendings`;
    ctx.timer?.start(timerName);
    try {
      if (!profileIds.length) return new Map();
      const sql = `select v.voter_profile_id as profile_id,coalesce(sum(case when e.status='ACTIVE' then abs(v.value) else 0 end),0) as spent
           from ${COMPETITION_VOTES_TABLE} v join ${COMPETITION_ENTRIES_TABLE} e on e.id=v.entry_id and e.competition_id=v.competition_id
           where v.competition_id=:competitionId and v.voter_profile_id in (:profileIds) group by v.voter_profile_id`;
      const rows = await this.db.execute<{ profile_id: string; spent: number }>(
        sql,
        {
          competitionId: competition.id,
          waveId: competition.wave_id,
          profileIds
        },
        { wrappedConnection: ctx.connection }
      );
      return new Map(rows.map((row) => [row.profile_id, Number(row.spent)]));
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async getSpending(
    competition: CompetitionCreditNamespace,
    profileId: string,
    entry: Pick<CompetitionEntry, 'id' | 'drop_id'> | undefined,
    ctx: RequestContext
  ): Promise<CompetitionCreditSpending> {
    const timerName = `${this.constructor.name}->getSpending`;
    ctx.timer?.start(timerName);
    try {
      // Storage mode is the only routing discriminator. In particular, a native
      // competition never consumes votes from its shared wave's legacy primary.
      const sql = `select
             coalesce(sum(case when e.status = 'ACTIVE' then abs(v.value) else 0 end), 0) as namespace_spent,
             coalesce(sum(case when e.id = :entryId and e.status = 'ACTIVE' then abs(v.value) else 0 end), 0) as entry_spent,
             coalesce(max(case when e.id = :entryId then v.value end), 0) as current_vote
           from ${COMPETITION_VOTES_TABLE} v
           join ${COMPETITION_ENTRIES_TABLE} e on e.id = v.entry_id and e.competition_id = v.competition_id
           where v.competition_id = :competitionId and v.voter_profile_id = :profileId`;
      const result = await this.db.oneOrNull<CompetitionCreditSpending>(
        sql,
        {
          competitionId: competition.id,
          waveId: competition.wave_id,
          profileId,
          entryId: entry?.id ?? null,
          dropId: entry?.drop_id ?? null
        },
        { wrappedConnection: ctx.connection }
      );
      return {
        namespace_spent: Number(result?.namespace_spent ?? 0),
        entry_spent: Number(result?.entry_spent ?? 0),
        current_vote: Number(result?.current_vote ?? 0)
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const competitionCreditRepository = new CompetitionCreditRepository(
  dbSupplier
);
