insert into deleted_drops (id, wave_id, created_at, author_id, deleted_at)
with all_drop_ids as (select reply_to_drop_id as drop_id, wave_id
                      from drops
                      where reply_to_drop_id is not null
                      union all
                      select quoted_drop_id as drop_id, wave_id
                      from drops_parts
                      where quoted_drop_id is not null),
     distinct_drop_ids as (select distinct drop_id, wave_id from all_drop_ids),
     missing_distinct_drop_ids as (select ddi.* from distinct_drop_ids ddi where ddi.drop_id not in (select drop_id from deleted_drops))
select drop_id as id, wave_id as wave_id, 0 as created_at, '' as author_id, 0 as deleted_at from missing_distinct_drop_ids;