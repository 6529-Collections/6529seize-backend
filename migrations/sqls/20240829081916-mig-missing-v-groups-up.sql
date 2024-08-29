update activity_events
    inner join (select ae.wave_id, ae.id, w.visibility_group_id
                from activity_events ae join waves w on ae.wave_id = w.id) as ds on ds.id = activity_events.id
set activity_events.visibility_group_id = ds.visibility_group_id
where activity_events.visibility_group_id is null and activity_events.wave_id <> ds.visibility_group_id;