insert ignore into wave_group_notification_subscriptions (
  identity_id,
  wave_id,
  mentioned_group
)
select distinct
  subscriber_id as identity_id,
  target_id as wave_id,
  'ALL' as mentioned_group
from identity_subscriptions
where target_type = 'WAVE'
  and target_action = 'DROP_CREATED';
