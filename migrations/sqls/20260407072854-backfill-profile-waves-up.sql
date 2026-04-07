insert into profile_waves (profile_id, wave_id)
select eligible.profile_id, eligible.wave_id
from (
  select created_by as profile_id, min(id) as wave_id
  from waves
  where is_direct_message = false
    and visibility_group_id is null
  group by created_by
  having count(*) = 1
) eligible
left join profile_waves existing_profile
  on existing_profile.profile_id = eligible.profile_id
left join profile_waves existing_wave
  on existing_wave.wave_id = eligible.wave_id
where existing_profile.profile_id is null
  and existing_wave.wave_id is null;
