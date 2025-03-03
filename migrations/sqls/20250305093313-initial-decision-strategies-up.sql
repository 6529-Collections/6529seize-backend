UPDATE waves
SET decisions_strategy = JSON_OBJECT(
        'first_decision_time', voting_period_end,
        'is_rolling', false,
        'subsequent_decisions', JSON_ARRAY()
                         )
WHERE type = 'RANK'
  and voting_period_end is not null
  and decisions_strategy is null;