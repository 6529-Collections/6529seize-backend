insert into metric_rollup_hour
  (hour_start, metric, scope, key1, key2, event_count, value_sum)
select
  timestampadd(
    hour,
    floor(unix_timestamp(pal.created_at) / 3600),
    '1970-01-01 00:00:00'
  ) as hour_start,
  'MAIN_STAGE_VOTE' as metric,
  pal.profile_id as scope,
  '' as key1,
  '' as key2,
  count(*) as event_count,
  sum(
    cast(json_unquote(json_extract(pal.contents, '$.newVote')) as signed) -
      cast(json_unquote(json_extract(pal.contents, '$.oldVote')) as signed)
  ) as value_sum
from profile_activity_logs pal
where pal.created_at >= date_sub(utc_timestamp(), interval 1 month)
  and pal.additional_data_2 = 'b6128077-ea78-4dd9-b381-52c4eadb2077'
  and pal.type = 'DROP_VOTE_EDIT'
  and (
    json_unquote(json_extract(pal.contents, '$.reason')) is null or
    json_unquote(json_extract(pal.contents, '$.reason')) != 'CREDIT_OVERSPENT'
  )
group by hour_start, pal.profile_id
on duplicate key update
  event_count = event_count + values(event_count),
  value_sum = value_sum + values(value_sum);
