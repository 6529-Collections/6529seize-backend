import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_SCORE_RESETS_TABLE
} from '@/constants';
import { legacyScoreResetsSql } from '@/competitions/competition-score-reset.repository';

/** Entry-first indexed reads exclude inactive history before the final sort. */
export function competitionScoreHistorySql(
  projected: boolean,
  aggregateOnly: boolean
): string {
  const resetSource = projected
    ? COMPETITION_SCORE_RESETS_TABLE
    : 'score_resets';
  return `${projected ? '' : `with score_resets as (${legacyScoreResetsSql})`}
      select h.entry_id, h.voter_profile_id,
      if(h.kind='VOTER',h.value,0) as value,
      if(h.kind='AGGREGATE',h.value,0) as aggregate_value,
      h.occurred_at,h.sequence,h.kind,
      if(h.mutation_sequence is null,h.sequence,:base+h.mutation_sequence) as order_sequence
      from ${COMPETITION_ENTRIES_TABLE} e
      straight_join ${COMPETITION_SCORE_HISTORY_TABLE} h force index (idx_competition_score_history_entry_time)
        on h.entry_id=e.id and h.competition_id=e.competition_id
      left join ${resetSource} revision_reset on revision_reset.entry_id=h.entry_id
        ${projected ? 'and revision_reset.competition_id=h.competition_id' : 'and revision_reset.reset_order=1'}
      where e.competition_id=:competitionId and e.status='ACTIVE'
        ${aggregateOnly ? "and h.kind='AGGREGATE'" : ''}
        and (revision_reset.entry_id is null
          or (h.mutation_sequence is not null and h.mutation_sequence>revision_reset.vote_history_sequence)
          or (h.mutation_sequence is null and h.sequence>
            if(h.kind='AGGREGATE',revision_reset.aggregate_history_sequence,revision_reset.voter_history_sequence)))
      order by h.occurred_at asc, order_sequence asc, h.kind asc`;
}
