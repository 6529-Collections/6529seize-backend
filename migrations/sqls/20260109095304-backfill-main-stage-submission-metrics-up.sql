insert into metric_rollup_hour
  (hour_start, metric, scope, key1, key2, event_count, value_sum)
select
  timestampadd(
    hour,
    floor(d.created_at / 1000 / 3600),
    '1970-01-01 00:00:00'
  ) as hour_start,
  'MAIN_STAGE_SUBMISSION' as metric,
  'global' as scope,
  '' as key1,
  '' as key2,
  count(*) as event_count,
  count(*) as value_sum
from drops d
where d.created_at >= unix_timestamp(date_sub(utc_timestamp(), interval 1 month)) * 1000
  and d.wave_id = 'b6128077-ea78-4dd9-b381-52c4eadb2077'
  and d.drop_type = 'PARTICIPATORY'
group by hour_start
on duplicate key update
  event_count = event_count + values(event_count),
  value_sum = value_sum + values(value_sum);
