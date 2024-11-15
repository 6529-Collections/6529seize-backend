with migd as (
    select l.id,
           concat(concat(concat(concat('{"newClaps": ', JSON_EXTRACT(contents, '$.new_rating')), ', "oldClaps": '), JSON_EXTRACT(contents, '$.old_rating')), '}')    as contents,
           'DROP_CLAPPED' as type
    from profile_activity_logs l
             join drops td on td.id = l.target_id
    where l.type = 'DROP_RATING_EDIT')
update profile_activity_logs l
    inner join migd on l.id = migd.id
set
    l.type = migd.type,
    l.contents = migd.contents
where l.type = 'DROP_RATING_EDIT';