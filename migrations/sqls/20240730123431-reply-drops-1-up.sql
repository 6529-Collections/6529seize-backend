insert into drops (id, wave_id, author_id, created_at, title, parts_count, reply_to_drop_id, reply_to_part_id)
select uuid()                                   as id,
       d.wave_id                                as wave_id,
       c.author_id                              as author_id,
       ROUND(UNIX_TIMESTAMP(CURTIME(4)) * 1000) as created_at,
       concat('id-', c.id)                           as title,
       1                                        as parts_count,
       c.drop_id                                as reply_to_drop_id,
       c.drop_part_id                           as reply_to_part_id
from drops_comments c
         join drops d on d.id = c.drop_id;