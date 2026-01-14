insert into metric_rollup_hour
  (hour_start, metric, scope, key1, key2, event_count, value_sum)
select
  timestamp(tgh.date) as hour_start,
  'NETWORK_TDH' as metric,
  'global' as scope,
  '' as key1,
  '' as key2,
  1 as event_count,
  tgh.total_boosted_tdh as value_sum
from tdh_global_history tgh
where tgh.date >= date_sub(utc_timestamp(), interval 1 month)
on duplicate key update
  event_count = values(event_count),
  value_sum = values(value_sum);
