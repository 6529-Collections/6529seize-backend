import {
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_ENTRIES_TABLE,
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
      snapshot_rows: number;
    }>(
      `select coalesce(sum(value),0) as total, count(nullif(value,0)) as count, count(*) as snapshot_rows,
       coalesce(max(case when voter_profile_id=:viewer then value end),0) as user_vote
       from ${table} where competition_id=:competitionId and entry_id=:entryId ${filter}`,
      { ...this.params(entry), viewer },
      { wrappedConnection: ctx.connection }
    );
    return {
      total: Number(rows[0].total),
      count: Number(rows[0].count),
      user_vote: Number(rows[0].user_vote),
      voters_count_available:
        entry.status !== 'WINNER' || Number(rows[0].snapshot_rows) > 0
    };
  }
  async score(entry: CompetitionEntry, ctx: RequestContext) {
    const winner = entry.status === 'WINNER';
    const rows = await this.db.execute<{
      rating: number;
      decision_rating: number;
      rank: number | null;
      over_threshold_since: number | null;
    }>(
      winner
        ? `select final_rating as rating, final_rating as decision_rating, \`rank\`, null as over_threshold_since from ${COMPETITION_DECISION_WINNERS_TABLE} where competition_id=:competitionId and entry_id=:entryId and decision_id=:decisionId`
        : `select lb.rating, coalesce(lb.decision_rating,lb.rating,0) as decision_rating, lb.\`rank\`, rt.over_threshold_since
           from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb
           join ${COMPETITION_ENTRIES_TABLE} e
             on e.competition_id=lb.competition_id and e.id=lb.entry_id
           left join ${COMPETITION_ENTRY_RUNTIME_TABLE} rt
             on rt.competition_id=lb.competition_id and rt.entry_id=lb.entry_id
           where lb.competition_id=:competitionId and lb.entry_id=:entryId`,
      this.params(entry),
      { wrappedConnection: ctx.connection }
    );
    return rows[0]
      ? {
          rating: Number(rows[0].rating),
          decision_rating: Number(rows[0].decision_rating),
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

  async allVoters(entry: CompetitionEntry, ctx: RequestContext) {
    const { table, filter } = this.source(entry);
    return this.db.execute<{ voter_id: string; vote: number }>(
      `select voter_profile_id as voter_id, value as vote from ${table}
       where competition_id=:competitionId and entry_id=:entryId ${filter} and value<>0
       order by value desc, voter_profile_id asc`,
      this.params(entry),
      { wrappedConnection: ctx.connection }
    );
  }

  async distribution(entry: CompetitionEntry, ctx: RequestContext) {
    const { table, filter } = this.source(entry);
    const rows = await this.db.execute<{
      drop_id: string;
      voter_id: string;
      vote: number;
      positive_total: number;
      negative_total: number;
    }>(
      `with votes as (
         select voter_profile_id as voter_id, value as vote from ${table}
         where competition_id=:competitionId and entry_id=:entryId ${filter} and value<>0
       ), totals as (
         select sum(case when vote>0 then vote else 0 end) as positive_total,
                sum(case when vote<0 then vote else 0 end) as negative_total
         from votes
       ), positive_votes as (
         select voter_id, vote from votes where vote>0
         order by vote desc, voter_id asc limit 3
       ), negative_votes as (
         select voter_id, vote from votes where vote<0
         order by vote asc, voter_id asc limit 3
       ), top_votes as (
         select * from positive_votes union all select * from negative_votes
       )
       select :dropId as drop_id, v.voter_id, v.vote, t.positive_total, t.negative_total
       from top_votes v cross join totals t
       order by abs(v.vote) desc, v.voter_id asc`,
      { ...this.params(entry), dropId: entry.drop_id },
      { wrappedConnection: ctx.connection }
    );
    return rows.map((row) => ({
      ...row,
      vote: Number(row.vote),
      positive_total: Number(row.positive_total),
      negative_total: Number(row.negative_total)
    }));
  }
}
export const competitionDropVotesDb = new CompetitionDropVotesDb(dbSupplier);
