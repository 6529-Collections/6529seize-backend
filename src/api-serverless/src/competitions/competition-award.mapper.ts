import { ApiCompetitionAward } from '@/api/generated/models/ApiCompetitionAward';
import { NativeDecisionAward } from '@/competitions/native-competition-runtime.repository';

export function toApiCompetitionAward(
  award: NativeDecisionAward
): ApiCompetitionAward {
  return {
    id: award.id,
    decision_id: award.decision_id,
    entry_id: award.entry_id,
    outcome_position: award.outcome_position,
    description: award.description,
    type: award.type,
    credit: award.credit,
    rep_category: award.rep_category,
    amount: award.amount
  };
}
