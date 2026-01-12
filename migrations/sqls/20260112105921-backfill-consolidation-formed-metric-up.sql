insert into metric_rollup_hour
  (hour_start, metric, scope, key1, key2, event_count, value_sum)
select
  timestamp(date_sub(utc_timestamp(), interval 1 day)) as hour_start,
  'CONSOLIDATIONS_FORMED' as metric,
  'global' as scope,
  '' as key1,
  '' as key2,
  1 as event_count,
  count(*) as value_sum
from tdh_consolidation
where consolidation_key like ('%-%')
on duplicate key update
  event_count = values(event_count),
  value_sum = values(value_sum);
