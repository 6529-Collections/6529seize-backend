with s_1 as (select id,
                    JSON_UNQUOTE(JSON_EXTRACT(pa_logs.contents, '$.rating_matter'))   as additional_data_1,
                    JSON_UNQUOTE(JSON_EXTRACT(pa_logs.contents, '$.rating_category')) as additional_data_2
             from profile_activity_logs pa_logs),
     s_2 as (select *
             from s_1
             where additional_data_1 is not null)
update profile_activity_logs l
    inner join s_2 on l.id = s_2.id
set
    l.additional_data_1 = s_2.additional_data_1,
    l.additional_data_2 = s_2.additional_data_2
where l.additional_data_1 is null;