insert into metric_rollup_hour
  (hour_start, metric, scope, key1, key2, event_count, value_sum)
select
  timestamp(utc_timestamp()) as hour_start,
  'XTDH_GRANTED' as metric,
  'global' as scope,
  '' as key1,
  '' as key2,
  1 as event_count,
  ifnull(floor(sum(xtdh_total)), 0) as value_sum
from
  (select active_slot from xtdh_stats_meta limit 1) meta
  join (
    select xtdh_total, 'a' as slot from xtdh_token_stats_a
    union all
    select xtdh_total, 'b' as slot from xtdh_token_stats_b
  ) stats
    on stats.slot = meta.active_slot
on duplicate key update
  event_count = values(event_count),
  value_sum = values(value_sum);
