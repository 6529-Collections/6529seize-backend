insert into winner_drop_voter_votes (drop_id, voter_id, wave_id, votes)
select wd.drop_id, dvs.voter_id, dvs.wave_id, dvs.votes
from wave_decision_winner_drops wd
         join drop_voter_states dvs on wd.drop_id = dvs.drop_id;