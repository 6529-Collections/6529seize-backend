import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE
} from '@/constants';
import { competitionEntryVisibleSql } from './competition-entry-visibility';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export interface CompetitionVoteActivity {
  readonly sequence: number | string;
  readonly drop_id: string;
  readonly voter_profile_id: string;
  readonly submitter_id: string;
  readonly previous_value: number | string;
  readonly value: number | string;
  readonly occurred_at: number | string;
}

export class CompetitionVoteActivityRepository extends LazyDbAccessCompatibleService {
  public async list(
    competitionId: string,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<CompetitionVoteActivity[]> {
    return this.db.execute<CompetitionVoteActivity>(
      `SELECT history.*, entry.drop_id, entry.submitter_id
       FROM ${COMPETITION_VOTE_HISTORY_TABLE} history
       JOIN ${COMPETITION_ENTRIES_TABLE} entry ON entry.competition_id = history.competition_id AND entry.id = history.entry_id
       WHERE history.competition_id = :competitionId AND ${competitionEntryVisibleSql('entry')}
       ORDER BY history.occurred_at DESC, history.sequence DESC LIMIT :offset, :limit`,
      { competitionId, offset, limit },
      { wrappedConnection: ctx.connection }
    );
  }
}

export const competitionVoteActivityRepository =
  new CompetitionVoteActivityRepository(dbSupplier);
