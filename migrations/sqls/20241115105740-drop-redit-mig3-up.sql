update profile_activity_logs l
    inner join drops td on td.id = l.target_id
set
    l.additional_data_1 = td.drop_type,
    l.additional_data_2 = td.wave_id
where l.type = 'DROP_CREATED';