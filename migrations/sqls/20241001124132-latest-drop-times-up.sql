update wave_metrics
    inner join (select wm.wave_id as wave_id, max(d.created_at) as created_at
                from wave_metrics wm
                         join drops d on wm.wave_id = d.wave_id
                group by 1) as wms on wms.wave_id = wave_metrics.wave_id
set wave_metrics.latest_drop_timestamp = wms.created_at
where wave_metrics.latest_drop_timestamp = 0;