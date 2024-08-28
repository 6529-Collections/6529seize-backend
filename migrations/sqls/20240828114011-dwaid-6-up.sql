update identity_subscriptions
set wave_id = target_id
where target_type = 'WAVE' and wave_id is null;