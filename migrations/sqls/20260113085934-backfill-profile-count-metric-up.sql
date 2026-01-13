insert into metric_rollup_hour
    (hour_start, metric, scope, key1, key2, event_count, value_sum)
with recursive
    dates as (select date(date_sub(utc_timestamp(), interval 1 month)) as day
              union all
              select date_add(day, interval 1 day)
              from dates
              where day < date(utc_timestamp())),
    baseline as (select count(distinct l.profile_id) as count_before
                 from profile_activity_logs l
                          join identities i
                               on i.profile_id = l.profile_id
                                   and i.normalised_handle is not null
                                   and i.normalised_handle not like 'id-0x%'
                 where l.type = 'PROFILE_CREATED'
                   and l.created_at < date(date_sub(utc_timestamp(), interval 1 month))),
    daily_new as (select date(l.created_at) as day,
                         count(distinct l.profile_id) as created_count
                  from profile_activity_logs l
                           join identities i
                                on i.profile_id = l.profile_id
                                    and i.normalised_handle is not null
                                    and i.normalised_handle not like 'id-0x%'
                  where l.type = 'PROFILE_CREATED'
                    and l.created_at >= date(date_sub(utc_timestamp(), interval 1 month))
                    and l.created_at < date_add(date(utc_timestamp()), interval 1 day)
                  group by date(l.created_at)),
    daily_counts as (select d.day,
                            (select count_before from baseline) +
                            sum(coalesce(n.created_count, 0)) over (order by d.day) as profile_count
                     from dates d
                              left join daily_new n on n.day = d.day)
select timestamp(date_add(day, interval 23 hour)) as hour_start,
       'PROFILE_COUNT'                            as metric,
       'global'                                   as scope,
       ''                                         as key1,
       ''                                         as key2,
       1                                          as event_count,
       profile_count                              as value_sum
from daily_counts
on duplicate key update event_count = values(event_count),
                        value_sum   = values(value_sum);
