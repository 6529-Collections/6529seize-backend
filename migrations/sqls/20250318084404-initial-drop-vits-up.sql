insert into drop_real_vote_in_time (
    drop_id,
    wave_id,
    timestamp,
    vote
) select
      d.id,
      d.wave_id,
      ifnull(lc.timestamp, d.created_at) as timestamp,
      ifnull(r.vote, 0) as vote
from drops d
         left join drop_ranks r on d.id = r.drop_id
         left join (select target_id as drop_id, CAST(UNIX_TIMESTAMP(max(created_at)) * 1000 AS UNSIGNED) as timestamp from profile_activity_logs where type = 'DROP_VOTE_EDIT' group by 1) as lc on lc.drop_id = d.id
where d.drop_type = 'PARTICIPATORY'