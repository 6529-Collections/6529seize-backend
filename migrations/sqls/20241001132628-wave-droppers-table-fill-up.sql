insert into wave_dropper_metrics (wave_id, dropper_id, latest_drop_timestamp, drops_count)
select d.wave_id       as wave_id,
       d.author_id     as dropper_id,
       max(created_at) as latest_drop_timestamp,
       count(*)        as drops_count
from drops d
group by d.wave_id, d.author_id
on duplicate key update drops_count           = values(drops_count),
                        latest_drop_timestamp = values(latest_drop_timestamp);
