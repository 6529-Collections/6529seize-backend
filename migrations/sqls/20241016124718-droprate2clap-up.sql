insert into drop_clapper_states (clapper_id, drop_id, claps, wave_id)
select r.rater_profile_id, r.matter_target_id, r.rating, d.wave_id
from ratings r
         join drops d on d.id = r.matter_target_id
where r.matter = 'DROP_RATING'
  and d.drop_type = 'CHAT';