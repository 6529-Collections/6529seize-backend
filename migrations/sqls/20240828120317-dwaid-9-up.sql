with s1 as (select id, target_id as wave_id from activity_events where target_type = 'WAVE')
update activity_events
    inner join (select * from s1) as ds on ds.id = activity_events.id
set activity_events.wave_id = ds.wave_id
where activity_events.wave_id is null;