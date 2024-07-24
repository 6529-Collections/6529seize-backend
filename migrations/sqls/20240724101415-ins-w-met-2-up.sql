update wave_metrics
    inner join (select target_id as wave_id, count(*) as subscriptions_count
                from identity_subscriptions
                where target_type = 'WAVE'
                group by target_id) as subscriptions on wave_metrics.wave_id = subscriptions.wave_id
set wave_metrics.subscribers_count = subscriptions.subscriptions_count;