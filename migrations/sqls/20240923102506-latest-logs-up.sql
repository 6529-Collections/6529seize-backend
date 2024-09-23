insert into profile_latest_logs (profile_id, latest_activity)
select profile_id as profile_id, max(created_at) as last_activity
from profile_activity_logs
group by 1
on duplicate key update latest_activity = values(latest_activity);