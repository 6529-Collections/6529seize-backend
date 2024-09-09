update activity_events
set action_author_id = JSON_UNQUOTE(JSON_EXTRACT(data, '$.creator_id'))
where target_type = 'WAVE' and action = 'DROP_CREATED';