with drop_subscriptions as (select s.id, s.target_id as drop_id, d.wave_id as wave_id
                            from identity_subscriptions s
                                     join drops d on d.id = s.target_id
                            where s.target_type = 'DROP')
update identity_subscriptions
    inner join (select id, wave_id
                from drop_subscriptions) as ds on ds.id = identity_subscriptions.id
set identity_subscriptions.wave_id = ds.wave_id
where identity_subscriptions.wave_id is null
  and identity_subscriptions.target_type = 'DROP';