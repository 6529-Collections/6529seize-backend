insert into drop_real_voter_vote_in_time (
    drop_id,
    wave_id,
    timestamp,
    vote,
    voter_id
) select
      d.id,
      d.wave_id,
      CAST(UNIX_TIMESTAMP(current_time) * 1000 AS UNSIGNED) as timestamp,
      ifnull(r.votes, 0) as vote,
      r.voter_id as voter_id
from drops d
        join OM6529.drop_voter_states r on d.id = r.drop_id
where d.drop_type = 'PARTICIPATORY'