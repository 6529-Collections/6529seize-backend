with n_d as (select id, ifnull(related_drop_id, related_drop_2_id) as drop_id from identity_notifications),
     n_d_2 as (select * from n_d where drop_id is not null),
     drop_notifications as (select n_d_2.id, drops.id as drop_id, drops.wave_id as wave_id
                            from n_d_2
                                     join drops on n_d_2.drop_id = drops.id)
update identity_notifications
    inner join (select * from drop_notifications) as ds on ds.id = identity_notifications.id
set identity_notifications.wave_id = ds.wave_id
where identity_notifications.wave_id is null;