update wave_metrics
    inner join (select wave_id, count(*) as drops_count
                from drops
                group by wave_id) as drop_counts on wave_metrics.wave_id = drop_counts.wave_id
set wave_metrics.drops_count = drop_counts.drops_count;