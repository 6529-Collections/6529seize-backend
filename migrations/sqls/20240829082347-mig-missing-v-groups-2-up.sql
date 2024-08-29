update identity_notifications
    inner join (select ae.wave_id, ae.id, w.visibility_group_id
                from identity_notifications ae join waves w on ae.wave_id = w.id) as ds on ds.id = identity_notifications.id
set identity_notifications.visibility_group_id = ds.visibility_group_id
where identity_notifications.visibility_group_id is null and identity_notifications.wave_id <> ds.visibility_group_id;