with s1 as (select id, JSON_UNQUOTE(JSON_EXTRACT(data, '$.drop_id')) as maybe_drop_id from activity_events),
     s2 as (select *
            from s1
            where maybe_drop_id is not null),
     s3 as (select s2.id as id, s2.maybe_drop_id as drop_id, d.wave_id as wave_id from s2 join drops d on d.id = s2.maybe_drop_id)
update activity_events
    inner join (select * from s3) as ds on ds.id = activity_events.id
set activity_events.wave_id = ds.wave_id
where activity_events.wave_id is null;