insert into metric_rollup_hour
(hour_start, metric, scope, key1, key2, event_count, value_sum)
with recursive dates as (
  select date(date_sub(utc_timestamp(), interval 1 month)) as day
  union all
  select date_add(day, interval 1 day)
  from dates
  where day < date(utc_timestamp())
),
filtered_logs as (
  select
    profile_id,
    target_id,
    created_at,
    cast(json_unquote(json_extract(contents, '$.newVote')) as signed) as new_vote
  from profile_activity_logs
  where type = 'DROP_VOTE_EDIT'
    and additional_data_2 = 'b6128077-ea78-4dd9-b381-52c4eadb2077'
    and (
      json_unquote(json_extract(contents, '$.reason')) is null or
      json_unquote(json_extract(contents, '$.reason')) != 'CREDIT_OVERSPENT'
    )
),
latest_votes as (
  select
    d.day,
    l.profile_id,
    l.target_id,
    l.new_vote,
    row_number() over (
      partition by d.day, l.profile_id, l.target_id
      order by l.created_at desc
    ) as rn
  from dates d
  join filtered_logs l
    on l.created_at < date_add(d.day, interval 1 day)
),
daily_totals as (
  select
    d.day,
    coalesce(sum(abs(l.new_vote)), 0) as total_tdh
  from dates d
  left join latest_votes l
    on l.day = d.day and l.rn = 1
  group by d.day
)
select
  timestamp(date_add(day, interval 23 hour)) as hour_start,
  'TDH_ON_MAIN_STAGE_SUBMISSIONS' as metric,
  'global' as scope,
  '' as key1,
  '' as key2,
  1 as event_count,
  total_tdh as value_sum
from daily_totals
on duplicate key update
  event_count = values(event_count),
  value_sum = values(value_sum);
