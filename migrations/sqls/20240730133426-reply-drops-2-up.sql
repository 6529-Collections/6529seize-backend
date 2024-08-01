insert into drops_parts (drop_id, drop_part_id, content)
with x as (
    select uuid()                                   as id,
           d.wave_id                                as wave_id,
           c.author_id                              as author_id,
           ROUND(UNIX_TIMESTAMP(CURTIME(4)) * 1000) as created_at,
           concat('id-', c.id)                           as title,
           1                                        as parts_count,
           c.drop_id                                as reply_to_drop_id,
           c.drop_part_id                           as reply_to_part_id
    from drops_comments c
             join drops d on d.id = c.drop_id
), y as (select id as drop_id, cast(regexp_replace(title, 'id-', '') as signed) as comment_id from x)
select d.id, 1, c.comment from drops_comments c
                                   join y on y.comment_id = c.id
                                   join drops d on d.title = concat('id-', c.id);