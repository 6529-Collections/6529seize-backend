UPDATE waves
SET next_decision_time = voting_period_end
WHERE type = 'RANK'
  and voting_period_end is not null and next_decision_time is null;