with s1 as (select a.id, d.wave_id as wave_id from activity_events a join drops d on d.id = a.target_id where a.target_type = 'DROP')
update activity_events
    inner join (select * from s1) as ds on ds.id = activity_events.id
set activity_events.wave_id = ds.wave_id
where activity_events.wave_id is null;