set @proxy_credit_backfill_now_ms = cast(unix_timestamp(utc_timestamp(3)) * 1000 as unsigned);

drop temporary table if exists tmp_proxy_rating_credit_events;
create temporary table tmp_proxy_rating_credit_events (
  proxy_action_id varchar(100) not null,
  matter varchar(50) not null,
  matter_target_id varchar(100) not null,
  matter_category varchar(256) not null,
  log_id varchar(100) not null,
  created_at datetime not null,
  delta bigint not null,
  index idx_tmp_prcb_events_key_time (
    proxy_action_id,
    matter,
    matter_target_id,
    matter_category,
    created_at,
    log_id
  )
);

insert into tmp_proxy_rating_credit_events
(
  proxy_action_id,
  matter,
  matter_target_id,
  matter_category,
  log_id,
  created_at,
  delta
)
with raw_logs as (
  select
    pal.id as log_id,
    pal.profile_id as grantor_profile_id,
    pal.proxy_id as proxy_profile_id,
    pal.target_id as matter_target_id,
    pal.additional_data_1 as matter,
    coalesce(pal.additional_data_2, '') as matter_category,
    cast(json_unquote(json_extract(pal.contents, '$.old_rating')) as signed) as old_rating,
    cast(json_unquote(json_extract(pal.contents, '$.new_rating')) as signed) as new_rating,
    pal.created_at as created_at,
    unix_timestamp(pal.created_at) as created_at_s
  from profile_activity_logs pal
  where pal.type = 'RATING_EDIT'
    and pal.proxy_id is not null
    and pal.target_id is not null
    and pal.additional_data_1 in ('REP', 'CIC')
    and pal.created_at is not null
    and json_extract(pal.contents, '$.old_rating') is not null
    and json_extract(pal.contents, '$.new_rating') is not null
    and json_unquote(json_extract(pal.contents, '$.old_rating')) regexp '^-?[0-9]+$'
    and json_unquote(json_extract(pal.contents, '$.new_rating')) regexp '^-?[0-9]+$'
),
candidate_actions as (
  select
    rl.log_id,
    ppa.id as proxy_action_id
  from raw_logs rl
  join profile_proxies pp
    on pp.created_by = rl.grantor_profile_id
    and pp.target_id = rl.proxy_profile_id
  join profile_proxy_actions ppa
    on ppa.proxy_id = pp.id
    and (
      (rl.matter = 'REP' and ppa.action_type = 'ALLOCATE_REP')
      or (rl.matter = 'CIC' and ppa.action_type = 'ALLOCATE_CIC')
    )
    and ppa.accepted_at is not null
    and floor(ppa.accepted_at / 1000) <= rl.created_at_s
    and floor(ppa.start_time / 1000) <= rl.created_at_s
    and (ppa.end_time is null or floor(ppa.end_time / 1000) >= rl.created_at_s)
    and (ppa.revoked_at is null or floor(ppa.revoked_at / 1000) >= rl.created_at_s)
    and (ppa.rejected_at is null or floor(ppa.rejected_at / 1000) >= rl.created_at_s)
),
uniquely_mapped_logs as (
  select
    ca.log_id,
    min(ca.proxy_action_id) as proxy_action_id
  from candidate_actions ca
  group by ca.log_id
  having count(distinct ca.proxy_action_id) = 1
)
select
  uml.proxy_action_id,
  rl.matter,
  rl.matter_target_id,
  rl.matter_category,
  rl.log_id,
  rl.created_at,
  abs(rl.new_rating) - abs(rl.old_rating) as delta
from raw_logs rl
join uniquely_mapped_logs uml
  on uml.log_id = rl.log_id
where abs(rl.new_rating) <> abs(rl.old_rating);

drop temporary table if exists tmp_proxy_rating_credit_balances_computed;
create temporary table tmp_proxy_rating_credit_balances_computed (
  proxy_action_id varchar(100) not null,
  matter varchar(50) not null,
  matter_target_id varchar(100) not null,
  matter_category varchar(256) not null,
  credit_spent_outstanding bigint not null,
  unique key uq_tmp_prcb_computed_key (
    proxy_action_id,
    matter,
    matter_target_id,
    matter_category
  )
);

insert into tmp_proxy_rating_credit_balances_computed
(
  proxy_action_id,
  matter,
  matter_target_id,
  matter_category,
  credit_spent_outstanding
)
with running as (
  select
    e.proxy_action_id,
    e.matter,
    e.matter_target_id,
    e.matter_category,
    e.log_id,
    e.created_at,
    sum(e.delta) over (
      partition by
        e.proxy_action_id,
        e.matter,
        e.matter_target_id,
        e.matter_category
      order by e.created_at asc, e.log_id asc
      rows between unbounded preceding and current row
    ) as running_sum
  from tmp_proxy_rating_credit_events e
),
final_rows as (
  select
    r.proxy_action_id,
    r.matter,
    r.matter_target_id,
    r.matter_category,
    r.running_sum,
    min(r.running_sum) over (
      partition by
        r.proxy_action_id,
        r.matter,
        r.matter_target_id,
        r.matter_category
    ) as min_running_sum,
    row_number() over (
      partition by
        r.proxy_action_id,
        r.matter,
        r.matter_target_id,
        r.matter_category
      order by r.created_at desc, r.log_id desc
    ) as rn_desc
  from running r
)
select
  fr.proxy_action_id,
  fr.matter,
  fr.matter_target_id,
  fr.matter_category,
  cast(fr.running_sum - least(0, fr.min_running_sum) as signed) as credit_spent_outstanding
from final_rows fr
where fr.rn_desc = 1
  and (fr.running_sum - least(0, fr.min_running_sum)) > 0;

insert into profile_proxy_rating_credit_balances
(
  proxy_action_id,
  matter,
  matter_target_id,
  matter_category,
  credit_spent_outstanding,
  created_at,
  updated_at
)
select
  c.proxy_action_id,
  c.matter,
  c.matter_target_id,
  c.matter_category,
  c.credit_spent_outstanding,
  @proxy_credit_backfill_now_ms,
  @proxy_credit_backfill_now_ms
from tmp_proxy_rating_credit_balances_computed c
on duplicate key update
  credit_spent_outstanding = values(credit_spent_outstanding),
  updated_at = values(updated_at);

delete current_balances
from profile_proxy_rating_credit_balances current_balances
left join tmp_proxy_rating_credit_balances_computed computed
  on computed.proxy_action_id = current_balances.proxy_action_id
  and computed.matter = current_balances.matter
  and computed.matter_target_id = current_balances.matter_target_id
  and computed.matter_category = current_balances.matter_category
where computed.proxy_action_id is null;

update profile_proxy_actions ppa
left join (
  select
    b.proxy_action_id,
    sum(b.credit_spent_outstanding) as total_credit_spent_outstanding
  from profile_proxy_rating_credit_balances b
  group by b.proxy_action_id
) action_totals
  on action_totals.proxy_action_id = ppa.id
set ppa.credit_spent = coalesce(action_totals.total_credit_spent_outstanding, 0)
where ppa.action_type in ('ALLOCATE_REP', 'ALLOCATE_CIC');

drop temporary table if exists tmp_proxy_rating_credit_events;
drop temporary table if exists tmp_proxy_rating_credit_balances_computed;
