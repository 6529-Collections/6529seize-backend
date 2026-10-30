import {
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE
} from '@/constants';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { RequestContext } from '@/request.context';

type EntryTotal = {
  entry_id: string;
  total: number;
  count: number;
  snapshot_rows: number;
  user_vote: number;
};
type EntryScore = {
  entry_id: string;
  rating: number;
  rank: number | null;
  over_threshold_since: number | null;
};
type EntryVoter = { entry_id: string; voter_id: string; vote: number };

// Each source is constrained before aggregation, including the winner's decision.
const voteRows = `select v.entry_id,v.voter_profile_id,v.value
  from ${COMPETITION_VOTES_TABLE} v
  join ${COMPETITION_ENTRIES_TABLE} e on e.id=v.entry_id and e.competition_id=v.competition_id
  where v.competition_id=:competitionId and v.entry_id in (:entryIds) and e.status='ACTIVE'
  union all
  select v.entry_id,v.voter_profile_id,v.value
  from ${COMPETITION_WINNER_VOTES_TABLE} v
  join ${COMPETITION_ENTRIES_TABLE} e on e.id=v.entry_id and e.competition_id=v.competition_id and e.decision_id=v.decision_id
  where v.competition_id=:competitionId and v.entry_id in (:entryIds) and e.status='WINNER'`;

export class CompetitionEntrySummaryDb extends LazyDbAccessCompatibleService {
  async read(
    competitionId: string,
    entryIds: readonly string[],
    viewer: string | null,
    ctx: RequestContext
  ) {
    if (!entryIds.length)
      return {
        totals: new Map<string, EntryTotal>(),
        scores: new Map<string, EntryScore>(),
        voters: [] as EntryVoter[]
      };
    const params = { competitionId, entryIds, viewer };
    const options = { wrappedConnection: ctx.connection };
    const [totals, scores, voters] = await Promise.all([
      this.db.execute<EntryTotal>(
        `with vote_rows as (${voteRows})
         select entry_id,coalesce(sum(value),0) as total,count(nullif(value,0)) as count,
           count(*) as snapshot_rows,coalesce(max(case when voter_profile_id=:viewer then value end),0) as user_vote
         from vote_rows group by entry_id`,
        params,
        options
      ),
      this.db.execute<EntryScore>(
        `select e.id as entry_id,
           case when e.status='WINNER' then coalesce(w.final_rating,0) else coalesce(lb.rating,0) end as rating,
           case when e.status='WINNER' then coalesce(w.\`rank\`,e.\`rank\`) else lb.\`rank\` end as \`rank\`,
           case when e.status='ACTIVE' then rt.over_threshold_since else null end as over_threshold_since
         from ${COMPETITION_ENTRIES_TABLE} e
         left join ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb on lb.competition_id=e.competition_id and lb.entry_id=e.id
         left join ${COMPETITION_DECISION_WINNERS_TABLE} w on w.competition_id=e.competition_id and w.entry_id=e.id and w.decision_id=e.decision_id
         left join ${COMPETITION_ENTRY_RUNTIME_TABLE} rt on rt.competition_id=e.competition_id and rt.entry_id=e.id
         where e.competition_id=:competitionId and e.id in (:entryIds)`,
        params,
        options
      ),
      this.db.execute<EntryVoter>(
        `with vote_rows as (${voteRows}), ranked as (
           select entry_id,voter_profile_id as voter_id,value as vote,
             row_number() over (partition by entry_id order by abs(value) desc,voter_profile_id asc) as position
           from vote_rows where value<>0
         ) select entry_id,voter_id,vote from ranked where position<=5 order by entry_id,position`,
        params,
        options
      )
    ]);
    return {
      totals: new Map(totals.map((row) => [row.entry_id, row])),
      scores: new Map(scores.map((row) => [row.entry_id, row])),
      voters
    };
  }
}
export const competitionEntrySummaryDb = new CompetitionEntrySummaryDb(
  dbSupplier
);
