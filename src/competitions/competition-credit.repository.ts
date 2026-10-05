import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE
} from '@/constants';
import { CompetitionStorageMode } from '@/entities/ICompetition';
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
      const sql =
        competition.storage_mode === CompetitionStorageMode.NATIVE
          ? `select
             coalesce(sum(case when e.status = 'ACTIVE' then abs(v.value) else 0 end), 0) as namespace_spent,
             coalesce(sum(case when e.id = :entryId and e.status = 'ACTIVE' then abs(v.value) else 0 end), 0) as entry_spent,
             coalesce(max(case when e.id = :entryId then v.value end), 0) as current_vote
           from ${COMPETITION_VOTES_TABLE} v
           join ${COMPETITION_ENTRIES_TABLE} e on e.id = v.entry_id and e.competition_id = v.competition_id
           where v.competition_id = :competitionId and v.voter_profile_id = :profileId`
          : `select
             coalesce(sum(case when d.drop_type = 'PARTICIPATORY' then abs(v.votes) else 0 end), 0) as namespace_spent,
             coalesce(sum(case when d.id = :dropId and d.drop_type = 'PARTICIPATORY' then abs(v.votes) else 0 end), 0) as entry_spent,
             coalesce(max(case when d.id = :dropId then v.votes end), 0) as current_vote
           from ${DROP_VOTER_STATE_TABLE} v
           join ${DROPS_TABLE} d on d.id = v.drop_id and d.wave_id = v.wave_id
           where v.wave_id = :waveId and v.voter_id = :profileId`;
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
