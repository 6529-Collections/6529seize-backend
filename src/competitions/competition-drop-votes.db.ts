import {
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE
} from '@/constants';
import { CompetitionEntry } from './competition.types';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { RequestContext } from '@/request.context';

export class CompetitionDropVotesDb extends LazyDbAccessCompatibleService {
  private source(entry: CompetitionEntry) {
    return entry.status === 'WINNER'
      ? {
          table: COMPETITION_WINNER_VOTES_TABLE,
          filter: 'and decision_id=:decisionId'
        }
      : { table: COMPETITION_VOTES_TABLE, filter: '' };
  }
  private params(entry: CompetitionEntry) {
    return {
      competitionId: entry.competition_id,
      entryId: entry.id,
      decisionId: entry.decision_id
    };
  }
  async totals(
    entry: CompetitionEntry,
    viewer: string | null,
    ctx: RequestContext
  ) {
    const { table, filter } = this.source(entry);
    const rows = await this.db.execute<{
      total: number;
      count: number;
      user_vote: number;
    }>(
      `select coalesce(sum(value),0) as total, count(nullif(value,0)) as count,
       coalesce(max(case when voter_profile_id=:viewer then value end),0) as user_vote
       from ${table} where competition_id=:competitionId and entry_id=:entryId ${filter}`,
      { ...this.params(entry), viewer },
      { wrappedConnection: ctx.connection }
    );
    return {
      total: Number(rows[0].total),
      count: Number(rows[0].count),
      user_vote: Number(rows[0].user_vote)
    };
  }
  async score(entry: CompetitionEntry, ctx: RequestContext) {
    const winner = entry.status === 'WINNER';
    const rows = await this.db.execute<{
      rating: number;
      rank: number | null;
      over_threshold_since: number | null;
    }>(
      winner
        ? `select final_rating as rating, \`rank\`, null as over_threshold_since from ${COMPETITION_DECISION_WINNERS_TABLE} where competition_id=:competitionId and entry_id=:entryId and decision_id=:decisionId`
        : `select lb.rating, lb.\`rank\`, rt.over_threshold_since from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb left join ${COMPETITION_ENTRY_RUNTIME_TABLE} rt on rt.competition_id=lb.competition_id and rt.entry_id=lb.entry_id where lb.competition_id=:competitionId and lb.entry_id=:entryId`,
      this.params(entry),
      { wrappedConnection: ctx.connection }
    );
    return rows[0]
      ? {
          rating: Number(rows[0].rating),
          over_threshold_since:
            rows[0].over_threshold_since == null
              ? null
              : Number(rows[0].over_threshold_since),
          rank: rows[0].rank === null ? null : Number(rows[0].rank)
        }
      : null;
  }
  async voters(
    entry: CompetitionEntry,
    offset: number,
    limit: number,
    direction: string,
    ctx: RequestContext
  ) {
    const { table, filter } = this.source(entry);
    return this.db.execute<{ voter_id: string; vote: number }>(
      `select voter_profile_id as voter_id, value as vote from ${table}
       where competition_id=:competitionId and entry_id=:entryId ${filter} and value<>0
       order by abs(value) ${direction === 'ASC' ? 'asc' : 'desc'}, voter_profile_id asc limit :offset,:limit`,
      { ...this.params(entry), offset, limit },
      { wrappedConnection: ctx.connection }
    );
  }
  async logs(
    entry: CompetitionEntry,
    offset: number,
    limit: number,
    direction: string,
    ctx: RequestContext
  ) {
    return this.db.execute<{
      id: string;
      voter_profile_id: string;
      old_vote: number;
      new_vote: number;
      created_at: number;
    }>(
      `select cast(sequence as char) as id, voter_profile_id, previous_value as old_vote, value as new_vote, occurred_at as created_at
       from ${COMPETITION_VOTE_HISTORY_TABLE} where competition_id=:competitionId and entry_id=:entryId
       order by sequence ${direction === 'ASC' ? 'asc' : 'desc'} limit :offset,:limit`,
      { ...this.params(entry), offset, limit },
      { wrappedConnection: ctx.connection }
    );
  }
}
export const competitionDropVotesDb = new CompetitionDropVotesDb(dbSupplier);
