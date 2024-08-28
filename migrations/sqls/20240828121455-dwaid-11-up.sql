with s1 as (select id, JSON_UNQUOTE(JSON_EXTRACT(data, '$.wave_id')) as maybe_wave_id from activity_events),
     s2 as (select *
            from s1
            where maybe_wave_id is not null)
update activity_events
    inner join (select * from s2) as ds on ds.id = activity_events.id
set activity_events.wave_id = ds.maybe_wave_id
where activity_events.wave_id is null;