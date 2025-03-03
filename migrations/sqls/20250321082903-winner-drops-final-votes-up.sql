update wave_decision_winner_drops w
    inner join (select drop_id, sum(votes) as votes from drop_voter_states group by 1) as vd on w.drop_id = vd.drop_id
set w.final_vote = vd.votes
where vd.votes <> 0;