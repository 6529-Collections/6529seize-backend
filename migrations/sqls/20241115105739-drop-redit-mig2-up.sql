update profile_activity_logs l
    inner join drops td on td.id = l.target_id
set
    l.additional_data_1 = td.author_id,
    l.additional_data_2 = td.wave_id
where l.type in ('DROP_CLAPPED', 'DROP_VOTE_EDIT');