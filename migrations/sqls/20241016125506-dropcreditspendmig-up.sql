insert into clap_credit_spendings (clapper_id, drop_id, credit_spent, wave_id, created_at)
select rater_id, drop_id, credit_spent, wave_id, UNIX_TIMESTAMP(timestamp) * 1000
from drops_votes_credit_spendings;